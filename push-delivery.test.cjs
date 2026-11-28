const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = readFileSync(`${__dirname}/index.js`, 'utf8');
const section = source.slice(source.indexOf('const isExpoPushToken ='), source.indexOf('// ── Registrar token VoIP'));
const expo = 'ExpoPushToken[test-device]';
const apns = 'a'.repeat(64);

function harness(subscriptions, tickets = [{ status: 'ok' }], upsertError = null, options = {}) {
  const sent = { expo: [], apns: [], fcm: [], upsert: [], deletes: [] };
  const routes = {};
  const supabase = { from(table) {
    const filters = {};
    let pendingDelete = false;
    const query = {
      select() { return query; }, eq(key, value) { filters[key] = value; return query; }, in() { return query; },
      neq(key, value) { filters[`neq:${key}`] = value; return query; },
      delete() { pendingDelete = true; return query; },
      upsert(record) { sent.upsert.push(record); return Promise.resolve({ error: upsertError }); },
      then(resolve, reject) {
        if (pendingDelete) sent.deletes.push({ ...filters });
        return Promise.resolve({ data: table === 'expo_push_tokens' ? subscriptions : [] }).then(resolve, reject);
      },
    };
    return query;
  } };
  const context = {
    supabase, Buffer, console: { warn() {}, error() {}, log() {} },
    process: { env: {} }, auth() {}, app: { post(path, auth, handler) { routes[path] = handler; } },
    getApnsVoipJwt: () => 'mock-jwt',
    sendApnsVoip: async (...args) => { sent.apns.push(args); return { ok: true }; },
    fetch: async (url, options) => {
      assert.equal(url, 'https://exp.host/--/api/v2/push/send');
      sent.expo.push(...JSON.parse(options.body));
      return { ok: true, json: async () => ({ data: tickets }) };
    },
    webpush: { sendNotification() { throw new Error('Unexpected web push'); } },
  };
  vm.createContext(context);
  const firebaseSetup = options.firebaseMissing
    ? ''
    : '\nfirebaseMessaging = {send: async message => captureFcm(message)};';
  vm.runInContext(section + '\nthis.send = sendPushToUser;' + firebaseSetup, Object.assign(context, {
    captureFcm: async message => {
      if (options.fcmError) throw options.fcmError;
      sent.fcm.push(message);
    },
  }));
  return { sent, send: context.send, register: routes['/api/push/register-expo-token'] };
}

const payload = { title: 'Sender', body: 'Hello', senderId: 'sender', senderAvatar: 'https://example.test/avatar.jpg', chatId: 'chat', messageType: 'text' };

test('mixed tokens use separate transports, preserving message sound and avatar', async () => {
  const h = harness([
    { token: expo, token_type: 'expo', device_id: 'expo-device' },
    { token: apns, token_type: 'apns', device_id: 'ios-device' },
    { token: 'fcm-native-token', token_type: 'fcm', device_id: 'android-device' },
  ]);
  await h.send('user', payload);
  assert.equal(h.sent.expo.length, 1);
  assert.equal(h.sent.expo[0].to, expo);
  assert.equal(h.sent.expo[0].mutableContent, true);
  const [, , content, type] = h.sent.apns[0];
  assert.equal(type.pushType, 'alert');
  assert.equal(content.aps['mutable-content'], 1);
  assert.equal(content.aps.sound, 'egchat-message.wav');
  assert.equal(content.senderAvatar, payload.senderAvatar);
  assert.equal(content.senderId, 'sender');
  assert.equal(h.sent.fcm.length, 1);
  assert.equal(h.sent.fcm[0].android.notification.channelId, 'egchat-messages');
  assert.equal(h.sent.fcm[0].android.notification.sound, 'notification');
  assert.equal(h.sent.fcm[0].data.senderAvatar, payload.senderAvatar);
});

test('successful Expo ticket suppresses only native tokens of the same identified device', async () => {
  const h = harness([{ token: expo, device_id: 'one', token_type: 'expo' }, { token: apns, device_id: 'one', token_type: 'apns' }, { token: 'b'.repeat(64), device_id: 'two', token_type: 'apns' }]);
  await h.send('user', payload);
  assert.equal(h.sent.apns.length, 1);
  assert.equal(h.sent.apns[0][0], 'b'.repeat(64));
});

test('failed Expo ticket falls back to the same device native transport', async () => {
  const h = harness([{ token: expo, device_id: 'one', token_type: 'expo' }, { token: apns, device_id: 'one', token_type: 'apns' }], [{ status: 'error', details: { error: 'InvalidCredentials' } }]);
  await h.send('user', payload);
  assert.equal(h.sent.apns.length, 1);
});

test('successful Expo ticket suppresses FCM of the same device', async () => {
  const h = harness([{ token: expo, device_id: 'one', token_type: 'expo' }, { token: 'fcm-native-token', device_id: 'one', token_type: 'fcm' }]);
  const result = await h.send('user', payload);
  assert.equal(h.sent.fcm.length, 0);
  assert.equal(result.expo, 1);
});

test('Android calls use direct FCM instead of an Expo banner', async () => {
  const h = harness([
    { token: expo, device_id: 'android-one', token_type: 'expo', platform: 'android' },
    { token: 'fcm-native-token', device_id: 'android-one', token_type: 'fcm', platform: 'android' },
  ]);
  await h.send('user', { ...payload, notificationType: 'incoming_call', callId: 'call' });
  assert.equal(h.sent.expo.length, 0);
  assert.equal(h.sent.fcm.length, 1);
  assert.equal(h.sent.fcm[0].notification, undefined);
});

test('Android calls without direct FCM keep the Expo fallback', async () => {
  const h = harness([{ token: expo, token_type: 'expo', platform: 'android' }]);
  await h.send('user', { ...payload, notificationType: 'incoming_call', callId: 'call' });
  assert.equal(h.sent.expo.length, 1);
  assert.equal(h.sent.fcm.length, 0);
});

test('an Android FCM device does not remove Expo from another Android device', async () => {
  const h = harness([
    { token: expo, device_id: 'old-android', token_type: 'expo', platform: 'android' },
    { token: 'fcm-native-token', device_id: 'new-android', token_type: 'fcm', platform: 'android' },
  ]);
  await h.send('user', { ...payload, notificationType: 'incoming_call', callId: 'call' });
  assert.equal(h.sent.expo.length, 1);
  assert.equal(h.sent.expo[0].to, expo);
  assert.equal(h.sent.fcm.length, 1);
});

test('iOS calls suppress APNs when Expo accepted the same device', async () => {
  const h = harness([
    { token: expo, device_id: 'iphone', token_type: 'expo', platform: 'ios' },
    { token: apns, device_id: 'iphone', token_type: 'apns', platform: 'ios' },
  ]);
  await h.send('user', { ...payload, notificationType: 'incoming_call', callId: 'call' });
  assert.equal(h.sent.expo.length, 1);
  assert.equal(h.sent.apns.length, 0);
});

test('failed FCM call falls back to Expo on the same device', async () => {
  const h = harness([
    { token: expo, device_id: 'android-one', token_type: 'expo', platform: 'android' },
    { token: 'fcm-native-token', device_id: 'android-one', token_type: 'fcm', platform: 'android' },
  ], [{ status: 'ok' }], null, { fcmError: new Error('FCM unavailable') });
  const result = await h.send('user', { ...payload, notificationType: 'incoming_call', callId: 'call' });
  assert.equal(h.sent.expo.length, 1);
  assert.equal(result.expo, 1);
});

test('missing Firebase credentials fall back to Expo for calls', async () => {
  const h = harness([
    { token: expo, device_id: 'android-one', token_type: 'expo', platform: 'android' },
    { token: 'fcm-native-token', device_id: 'android-one', token_type: 'fcm', platform: 'android' },
  ], [{ status: 'ok' }], null, { firebaseMissing: true });
  await h.send('user', { ...payload, notificationType: 'incoming_call', callId: 'call' });
  assert.equal(h.sent.expo.length, 1);
  assert.equal(h.sent.fcm.length, 0);
});

test('legacy tokens without device id use one conservative transport', async () => {
  const call = harness([
    { token: expo, token_type: 'expo', platform: 'android' },
    { token: 'fcm-native-token', token_type: 'fcm', platform: 'android' },
  ]);
  await call.send('user', { ...payload, notificationType: 'incoming_call', callId: 'call' });
  assert.equal(call.sent.expo.length, 0);
  assert.equal(call.sent.fcm.length, 1);

  const message = harness([
    { token: expo, token_type: 'expo', platform: 'android' },
    { token: 'fcm-native-token', token_type: 'fcm', platform: 'android' },
  ]);
  await message.send('user', payload);
  assert.equal(message.sent.expo.length, 1);
  assert.equal(message.sent.fcm.length, 0);
});

test('APNs-only devices receive alerts without an Expo request', async () => {
  const h = harness([{ token: apns, token_type: 'apns' }]);
  await h.send('user', payload);
  assert.equal(h.sent.expo.length, 0);
  assert.equal(h.sent.apns.length, 1);
});

test('PushKit VoIP tokens are never sent to the APNs alert topic', async () => {
  const voip = 'c'.repeat(64);
  const h = harness([{ token: voip, token_type: 'voip' }, { token: apns, token_type: 'apns' }]);
  await h.send('user', payload);
  assert.equal(h.sent.apns.length, 1);
  assert.equal(h.sent.apns[0][0], apns);
  assert.equal(h.sent.deletes.length, 0);
});

test('both Expo prefixes route through Expo even if previously mislabeled', async () => {
  const h = harness([{ token: expo, token_type: 'apns' }, { token: 'ExponentPushToken[old-device]', token_type: 'fcm' }], [{ status: 'ok' }, { status: 'ok' }]);
  await h.send('user', payload);
  assert.equal(h.sent.expo.length, 2);
  assert.equal(h.sent.apns.length + h.sent.fcm.length, 0);
});

test('call fallback does not invoke the communication extension and FCM remains data-only', async () => {
  const h = harness([{ token: apns, token_type: 'apns' }, { token: 'fcm-native-token', token_type: 'fcm' }]);
  await h.send('user', { ...payload, notificationType: 'incoming_call', callId: 'call' });
  assert.equal(h.sent.apns[0][2].aps['mutable-content'], undefined);
  assert.equal(h.sent.apns[0][2].aps.category, 'EGCHAT_CALL');
  assert.equal(h.sent.fcm[0].notification, undefined);
  assert.equal(h.sent.fcm[0].data.callId, 'call');
});

test('call summaries stay data-only so the native service can clear the ongoing call', async () => {
  const h = harness([
    { token: expo, token_type: 'expo', device_id: 'android-one' },
    { token: 'fcm-native-token', token_type: 'fcm', device_id: 'android-one' },
  ]);
  await h.send('user', { ...payload, notificationType: 'call_summary', callId: 'call' });
  assert.equal(h.sent.expo.length, 0);
  assert.equal(h.sent.fcm.length, 1);
  assert.equal(h.sent.fcm[0].notification, undefined);
  assert.equal(h.sent.fcm[0].android.notification, undefined);
  assert.equal(h.sent.fcm[0].data.notificationType, 'call_summary');
});

test('failed FCM call summary falls back to a data-only Expo message', async () => {
  const h = harness([
    { token: expo, token_type: 'expo', device_id: 'android-one' },
    { token: 'fcm-native-token', token_type: 'fcm', device_id: 'android-one' },
  ], [{ status: 'ok' }], null, { fcmError: new Error('FCM unavailable') });
  const result = await h.send('user', { ...payload, notificationType: 'call_summary', callId: 'call' });
  assert.equal(result.expo, 1);
  assert.equal(h.sent.expo.length, 1);
  assert.equal(h.sent.expo[0].title, undefined);
  assert.equal(h.sent.expo[0].body, undefined);
  assert.equal(h.sent.expo[0].sound, undefined);
  assert.equal(h.sent.expo[0].channelId, undefined);
  assert.equal(h.sent.expo[0].data.notificationType, 'call_summary');
  assert.equal(h.sent.expo[0].ttl, 120);
});

test('registration persists device association and reports database failure', async () => {
  for (const error of [null, { message: 'database rejected' }]) {
    const h = harness([], [], error);
    const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await h.register({ body: { expoPushToken: expo, tokenType: 'apns', platform: 'ios', deviceId: 'phone-one' }, user: { id: 'user' }, headers: {} }, response);
    assert.equal(h.sent.upsert[0].device_id, 'phone-one');
    assert.equal(h.sent.upsert[0].token_type, 'apns');
    assert.equal(h.sent.deletes.length, error ? 0 : 1);
    assert.equal(response.code, error ? 500 : 200);
  }
});

test('registration recognizes both Expo token prefixes without an explicit type', async () => {
  const h = harness([]);
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await h.register({ body: { expoPushToken: expo, platform: 'android', deviceId: 'phone-one' }, user: { id: 'user' }, headers: {} }, response);
  assert.equal(h.sent.upsert[0].token_type, 'expo');
});

test('registration replaces only the previous token from the same device', async () => {
  const h = harness([]);
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await h.register({ body: { expoPushToken: expo, platform: 'android', deviceId: 'phone-one' }, user: { id: 'user' }, headers: {} }, response);
  assert.deepEqual(h.sent.deletes, [{ user_id: 'user', device_id: 'phone-one', token_type: 'expo', 'neq:token': expo }]);
});

test('registration without a device id preserves tokens from other devices', async () => {
  const h = harness([]);
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await h.register({ body: { expoPushToken: expo, platform: 'android' }, user: { id: 'user' }, headers: {} }, response);
  assert.equal(h.sent.deletes.length, 0);
});

test('group info permissions require participation even when edit_info is all', async () => {
  const permissionSource = source.slice(source.indexOf('const participacionEnChat ='), source.indexOf('// El cliente manda PATCH'));
  const canEdit = (participant, settings) => {
    const context = { supabase: { from(table) {
      const query = {
        select() { return query; }, eq() { return query; },
        limit() { return Promise.resolve({ data: participant ? [participant] : [] }); },
        maybeSingle() { return Promise.resolve({ data: table === 'chats' ? { created_by: 'creator', settings } : null }); },
      };
      return query;
    } } };
    vm.createContext(context);
    vm.runInContext(permissionSource + '\nthis.canEdit = puedeEditarInfoChat; this.isPublicUrl = isPublicGroupImageUrl;', context);
    return context;
  };
  const outsider = canEdit(null, { edit_info: 'all' });
  assert.equal(await outsider.canEdit('group', 'outsider'), false);
  const member = canEdit({ role: 'member' }, { edit_info: 'all' });
  assert.equal(await member.canEdit('group', 'member'), true);
  assert.equal(member.isPublicUrl('https://example.test/group.jpg'), true);
  assert.equal(member.isPublicUrl('data:image/jpeg;base64,aGVsbG8='), false);
  const restricted = canEdit({ role: 'member' }, { edit_info: 'admins' });
  assert.equal(await restricted.canEdit('group', 'member'), false);
  const admin = canEdit({ role: 'admin' }, { edit_info: 'admins' });
  assert.equal(await admin.canEdit('group', 'admin'), true);
});

test('APNs helper uses alert topic without changing the VoIP default', async () => {
  const headers = [];
  const transport = source.slice(source.indexOf('const sendApnsVoip ='), source.indexOf('const sendVoipPushToUser ='));
  const context = { Buffer, setTimeout, clearTimeout, process: { env: {} }, APNS_VOIP_HOSTS: { production: 'api.push.apple.com' }, http2: { connect() {
    const client = new EventEmitter();
    client.destroy = () => {};
    client.request = values => {
      headers.push(values);
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => { request.emit('response', { ':status': 200 }); request.emit('end'); });
      return request;
    };
    return client;
  } } };
  vm.createContext(context);
  vm.runInContext(transport + '\nthis.send = sendApnsVoip;', context);
  await context.send(apns, 'jwt', {}, { pushType: 'alert' });
  await context.send(apns, 'jwt', {});
  assert.equal(headers[0]['apns-push-type'], 'alert');
  assert.equal(headers[0]['apns-topic'], 'com.jallzstores.egchat');
  assert.equal(headers[0]['apns-priority'], '10');
  assert.equal(headers[1]['apns-topic'], 'com.jallzstores.egchat.voip');
});

test('failed cover upload never persists a device-only data URI', async () => {
  const routeSource = source.slice(source.indexOf("app.post('/api/chats/:chatId/cover'"), source.indexOf("app.delete('/api/chats/:chatId/cover'"));
  let handler;
  let updates = 0;
  const query = {
    update() { updates++; return query; },
    eq() { return Promise.resolve({ error: null }); },
  };
  const context = {
    Buffer,
    console: { warn() {}, error() {}, log() {} },
    auth() {},
    app: { post(path, auth, fn) { handler = fn; } },
    puedeEditarInfoChat: async () => true,
    supabase: {
      from() { return query; },
      storage: { from() { return {
        upload: async () => ({ error: { message: 'storage unavailable' } }),
        getPublicUrl() { throw new Error('must not be called'); },
      }; } },
    },
  };
  vm.createContext(context);
  vm.runInContext(routeSource, context);
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await handler({ params: { chatId: 'group' }, body: { base64: 'data:image/jpeg;base64,aGVsbG8=', mimeType: 'image/jpeg' }, user: { id: 'user' } }, response);
  assert.equal(response.code, 502);
  assert.equal(updates, 0);
});

test('failed group avatar upload never persists a device-only data URI', async () => {
  const routeSource = source.slice(source.indexOf("app.post('/api/chats/:chatId/avatar'"), source.indexOf("app.post('/api/chats/:chatId/cover'"));
  let handler;
  let updates = 0;
  const query = {
    update() { updates++; return query; },
    eq() { return Promise.resolve({ error: null }); },
  };
  const context = {
    Buffer,
    console: { warn() {}, error() {}, log() {} },
    auth() {},
    app: { post(path, auth, fn) { handler = fn; } },
    puedeEditarInfoChat: async () => true,
    supabase: {
      from() { return query; },
      storage: { from() { return {
        upload: async () => ({ error: { message: 'storage unavailable' } }),
        getPublicUrl() { throw new Error('must not be called'); },
      }; } },
    },
  };
  vm.createContext(context);
  vm.runInContext(routeSource, context);
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ params: { chatId: 'group' }, body: { base64: 'data:image/jpeg;base64,aGVsbG8=', mimeType: 'image/jpeg' }, user: { id: 'user' } }, response);
  assert.equal(response.code, 502);
  assert.equal(updates, 0);
});
