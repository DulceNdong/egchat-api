// import-users-neon.cjs — Importa usuarios de Supabase a Neon
// Los datos vienen del CSV exportado del SQL Editor de Supabase
const { Client } = require('pg');

const NEON_URL = 'postgresql://neondb_owner:npg_QGsC87gwTEbL@ep-icy-smoke-a2znhutu.eu-central-1.aws.neon.tech/neondb?sslmode=require';

// Datos de usuarios exportados de Supabase (37 usuarios)
// Columnas: id, phone, full_name, password_hash, avatar_url, is_active, last_login, created_at, updated_at
const users = [
  { id: 'ccfbcbe3-3a22-4eb8-b1f8-c3b2387b224a', phone: '240829811782', full_name: 'E2E Flow', password_hash: '$2a$10$WhuvU9B2CqVt4Oqp/3wLFuHkjiQStHMe7XX52SM1aFHHsOPeaxSXu', avatar_url: 'https://i.pravatar.cc/300?img=22', is_active: true, last_login: null, created_at: '2026-04-10 14:03:48.760198+00', updated_at: '2026-04-10 14:03:48.760198+00' },
  { id: 'dadd0b54-48ee-47ca-83c1-2ae5e48ed787', phone: '240834257417', full_name: 'E2E Taxi Cemac', password_hash: '$2a$10$oCpLWgxYtkPZbYDL8X0rOODQqNC6.Z68aGTkUWJgcqqjXQbQpyjTm', avatar_url: 'https://i.pravatar.cc/300?img=12', is_active: true, last_login: null, created_at: '2026-04-10 15:17:39.783188+00', updated_at: '2026-04-10 15:17:39.783188+00' },
  { id: 'f1c4a458-862b-4317-8008-cb344d69b543', phone: '+240555570323', full_name: 'REDDINGTON', password_hash: '$2a$10$Cmfzl4RdxxECQusP/SggiOnaymWY2vU7ZQL317a1qOtBKSV7nTOma', avatar_url: null, is_active: true, last_login: '2026-06-02 17:55:26.215+00', created_at: '2026-04-10 17:40:51.633232+00', updated_at: '2026-06-02 17:55:26.221181+00' },
  { id: '4bd2598a-ffa9-4614-822b-58201061b5ea', phone: '+240222202530', full_name: 'charlis ', password_hash: '$2a$10$TlvHXAI2215/1y/eQO.wgu8W42a4rbFAMPzlwOtmE6flTh3N/q.3u', avatar_url: null, is_active: true, last_login: '2026-04-17 19:00:35.84+00', created_at: '2026-04-12 16:48:52.340592+00', updated_at: '2026-04-17 19:00:35.900322+00' },
  { id: '90e2b172-55d1-4708-a8c9-56f7dd59a718', phone: '+240222202535', full_name: 'santos ', password_hash: '$2a$10$wLp/d5nAHYorimndOUeaaebbJCMteuTsZosghZFf5tfbih1nxk2Ci', avatar_url: null, is_active: true, last_login: '2026-05-08 14:42:31.073+00', created_at: '2026-04-12 17:35:46.946871+00', updated_at: '2026-05-08 14:42:31.175596+00' },
  { id: 'fdc21eab-c7ef-457e-ba0a-2985a2c0366b', phone: '+240222202538', full_name: 'elvis ', password_hash: '$2a$10$q6MqAxcocyYLSjp3kEVizOF6x37IdZ2vCZXsmL.x8sK8707vMhSE.', avatar_url: null, is_active: true, last_login: '2026-05-25 14:53:09.838+00', created_at: '2026-04-12 18:17:12.923367+00', updated_at: '2026-05-25 14:53:09.859635+00' },
  { id: '1338fe25-9826-45f6-adfe-3b46268fa81d', phone: '+240222505012', full_name: 'bubu', password_hash: '$2a$10$SbP3GYHI/W9MViP7gp8opu.R4NKm3Dwzf86oAXtgf4Nd0zNRatoGS', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-13 16:07:38.879366+00', updated_at: '2026-04-13 16:07:38.879366+00' },
  { id: 'ad498f0c-8870-41a1-bd09-2c30392b82a6', phone: '+240555744063', full_name: 'Maribel Mikue❤️', password_hash: '$2a$10$XdGCjea4DQzYu5i9aK12ye8hsb0R6a.HkYEmFttoOWLBobSmVqEjy', avatar_url: null, is_active: true, last_login: '2026-04-27 10:27:38.991+00', created_at: '2026-04-17 08:18:19.02215+00', updated_at: '2026-04-27 10:27:39.015679+00' },
  { id: '1f804b4d-20c8-4e36-bd47-eb4195738ddb', phone: '+240222033494', full_name: 'Filomena Bindang ', password_hash: '$2a$10$5Q.ayL5G3JIcqBpAR3Rv7Oiqa5kNRO4IXWZBk2izvr8PshM0mHBBe', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-17 08:24:37.636212+00', updated_at: '2026-04-17 08:24:37.636212+00' },
  { id: '5c893eb5-689f-4d1f-8082-50c763a3b4cf', phone: '+240222128762', full_name: 'nnomo obiang', password_hash: '$2a$10$5jA5anHsBAz1cQG0n8NnX.62Ev1ceZ3xXO7QpZilP2Gedo8BCFaHi', avatar_url: null, is_active: true, last_login: '2026-04-27 10:13:59.119+00', created_at: '2026-04-17 08:44:00.07764+00', updated_at: '2026-04-27 10:13:59.166303+00' },
  { id: 'f826ee89-6af9-4561-86fd-ee7154495cb1', phone: '+240555333180', full_name: 'Francisco', password_hash: '$2a$10$a9Z5EDAKSldJjRP000X4juEJhIxl3E4JWQ3V5YjI9tExJVgRKOJL2', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-17 08:44:57.170239+00', updated_at: '2026-04-17 08:44:57.170239+00' },
  { id: '35fbe886-82ba-4d2c-ad1a-15d1f29926fe', phone: '+240222015634', full_name: 'Benjamin NZE', password_hash: '$2a$10$/NJSkKtpTiOM1GGGlJjSu.AVrr3m5khNLtiNPEcyAEKG3nvfCLDp.', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-17 09:17:57.39739+00', updated_at: '2026-04-17 09:17:57.39739+00' },
  { id: '07c561ed-3762-4540-b005-59b04e3340b4', phone: '+240555795330', full_name: 'Ashley ', password_hash: '$2a$10$32EMZEBBgRR6rUYnzQph6.JZJjy.8zE794JOPIxp1BB/pwz1E6H0.', avatar_url: null, is_active: true, last_login: '2026-05-03 23:32:59.542+00', created_at: '2026-04-17 10:39:45.387381+00', updated_at: '2026-05-03 23:32:59.564891+00' },
  { id: '93c8a2af-1fab-4ad0-ad18-b641a34a784d', phone: '+240222015637', full_name: 'Benja', password_hash: '$2a$10$e5dwlIRlyjOXMnh/64rx4.N.QjNjtsna/fPBycW3IX6dJo6CA1HTm', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-17 15:04:05.246289+00', updated_at: '2026-04-17 15:04:05.246289+00' },
  { id: '044b2e01-2565-43a6-86bd-b019dabb7d29', phone: '+240555570324', full_name: 'Miguel EDU', password_hash: '$2a$10$NspUCdXL/KSnCj1YEhGozO28eCdowsj7uugSlDj5KJ4l1rYPXoW7S', avatar_url: null, is_active: true, last_login: '2026-04-28 18:26:22.073+00', created_at: '2026-04-17 18:45:01.597028+00', updated_at: '2026-04-28 18:26:22.101455+00' },
  { id: '06435b21-0589-4b76-84c1-fc5e8889f78b', phone: '+2402131568', full_name: '0750830', password_hash: '$2a$10$n2D2RyqBM4ZfuX0wBOAMLes8zXzXQQih2LI6VziWNLd47fdJI27gy', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-17 19:31:24.038287+00', updated_at: '2026-04-17 19:31:24.038287+00' },
  { id: '40195907-4218-4986-b25b-41925e5ef6ca', phone: '+240222236442', full_name: 'Santito', password_hash: '$2a$10$kQIM73Dx2543O0hkMF1ylOjqWwJAkaX3qZvoB9C3ekt6APgg8dK46', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-18 20:45:01.668827+00', updated_at: '2026-04-18 20:45:01.668827+00' },
  { id: '5e394b94-cf58-49ad-a527-5c805d5f8283', phone: '+240222979503', full_name: 'Nchamita ', password_hash: '$2a$10$DZGtMUo.JoYxr8sAYV6IueOANqazQlA7TgH0BgCCXNIuxpCbMC2qK', avatar_url: null, is_active: true, last_login: '2026-05-29 19:23:51.466+00', created_at: '2026-04-19 10:05:24.310448+00', updated_at: '2026-05-29 19:23:51.513561+00' },
  { id: '0989d96b-ccf4-49d2-aa0f-7bf5a5273966', phone: '+24054645648483', full_name: 'Jdudi', password_hash: '$2a$10$Cy/mIt.DFOOXcQ64TCZCqe2ogzaDP.vPnMQpd6dmAMc7b70yC9JGe', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-20 18:57:08.047101+00', updated_at: '2026-04-20 18:57:08.047101+00' },
  { id: 'bf337153-8a7e-4d8b-ab68-3e6e9e3b5f46', phone: '+240555981120', full_name: 'Jacinto ', password_hash: '$2a$10$JXSsPMyGWzjFS7qAcKBIf.JALRpd4V1Us6fYy6QzeGV3nxG8NqJ1i', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-23 10:53:30.328568+00', updated_at: '2026-04-23 10:53:30.328568+00' },
  { id: '4953e041-f1cd-44d0-bc24-1cdc63e47d2e', phone: '+240222201309', full_name: 'Isidro Mba Obiang Avomo ', password_hash: '$2a$10$67C10Jt3bvPifb4s/p/jI.A6JIoAGvAormsnqN7ahT8E.OfdDEnre', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-25 11:03:11.143028+00', updated_at: '2026-04-25 11:03:11.143028+00' },
  { id: '94f8e3f4-8181-45ad-9c99-46e3c8437c88', phone: '+240555570321', full_name: 'Miguel Edu', password_hash: '$2a$10$uLF/Q9NlTEyPjvH2hxUg6ues1IV4og7LSgtwTOvo7jE8ZaQUl/LGm', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-26 18:12:42.173768+00', updated_at: '2026-04-26 18:12:42.173768+00' },
  { id: 'f6778a36-1c3d-4b2d-a519-f01d9f392d92', phone: '+240222235911', full_name: 'Margarita nchama ', password_hash: '$2a$10$50GlwFeKRKWNO0NzcuTU7eaecqhV85QTsJMemJIeAqaDAMgNvE4uC', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-26 18:38:10.866495+00', updated_at: '2026-04-26 18:38:10.866495+00' },
  { id: '32dd1fa7-977a-4be8-b6a8-b7ff3cd0185c', phone: '+240222274054', full_name: 'B. Continensa', password_hash: '$2a$10$l.dkU7baBrJXYDYgrcoumep32K2UinQiLXmNREobczKwXq0tmk8/.', avatar_url: null, is_active: true, last_login: '2026-04-26 19:14:06.509+00', created_at: '2026-04-26 19:11:11.351872+00', updated_at: '2026-04-26 19:14:06.542205+00' },
  { id: '8b37fea7-aa85-443e-96c8-fe765b4e858c', phone: '+240222258481', full_name: 'Pimp ', password_hash: '$2a$10$OtHilsD27OIwybqC8VaeHu/.E3zv8JeWVraEcQ9XsrFqciq9kFmbC', avatar_url: null, is_active: true, last_login: '2026-04-30 14:45:05.83+00', created_at: '2026-04-27 10:05:10.658479+00', updated_at: '2026-04-30 14:45:05.863051+00' },
  { id: '17be01f2-5a9b-4c86-a819-cb2b4e8e0415', phone: '+240555269674', full_name: 'Silvestre ', password_hash: '$2a$10$bE0OmBIub2873Mcd30CSp.jdobbpj.gFDa3g0JWv11x/KLPbsF2D.', avatar_url: null, is_active: true, last_login: '2026-06-01 13:11:00.545+00', created_at: '2026-04-27 10:17:54.533799+00', updated_at: '2026-06-01 13:11:00.602581+00' },
  { id: 'd7e8ae97-df4e-4e2e-876e-0740e1f2d2b6', phone: '+240555015637', full_name: 'Benjamín NZE ', password_hash: '$2a$10$sHpj/9VN45Vnyq/lquLN6ujclio5mF3FmH9FZEmA0n87xuwbWELn2', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-27 10:22:01.141134+00', updated_at: '2026-04-27 10:22:01.141134+00' },
  { id: 'f67509de-6729-4737-b9d2-72decfd52f2b', phone: '+240222988227', full_name: 'Javier Abaga ondo', password_hash: '$2a$10$RgZhVeq108VojbChu979zu0T2r5ZtkchL9LMjs2AltuyNiZ71oO/O', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-27 10:25:28.637868+00', updated_at: '2026-04-27 10:25:28.637868+00' },
  { id: '3dc4e621-24a1-40b0-ba32-7d48eed8eb14', phone: '+240222202040', full_name: 'Dulce', password_hash: '$2a$10$.OxNR0HzheYYHx31nv49E.Fk3uUkUn5JW1dU1GUL64gy1X6SleR.a', avatar_url: null, is_active: true, last_login: null, created_at: '2026-04-28 22:21:09.119782+00', updated_at: '2026-04-28 22:21:09.119782+00' },
  { id: '0a0c36ef-b048-4383-b9b0-4aeebdf54459', phone: '+240222697383', full_name: 'Ibrahim ', password_hash: '$2a$10$UqDbhVSYZPiDCKy/GdJ1FOx5HI4E7nUDpsNQGOjlM2A7XbTcRYfJe', avatar_url: null, is_active: true, last_login: null, created_at: '2026-05-03 13:05:52.048262+00', updated_at: '2026-05-03 13:05:52.048262+00' },
  { id: 'a150e706-3dd1-440a-8a11-0d0afdd59f9a', phone: '+240222697381', full_name: 'Ibrahim ', password_hash: '$2a$10$X48yf6ZOXKyZp8OQyzhlmePK2te9I/8lWh945QIQJaihoGrP/mAiS', avatar_url: null, is_active: true, last_login: null, created_at: '2026-05-03 13:06:57.425961+00', updated_at: '2026-05-03 13:06:57.425961+00' },
  { id: '5ac9d45a-7663-4c21-b467-99d1f7491f6e', phone: '+240555822883', full_name: 'Eustaquia Obono', password_hash: '$2a$10$9SasJQvLedfBF6gxGh74U.CX6q7Mwy0m8rY5IvjvqauqB9CCGr.c2', avatar_url: null, is_active: true, last_login: '2026-05-08 14:14:17.839+00', created_at: '2026-05-08 12:58:02.06948+00', updated_at: '2026-05-08 14:14:17.883011+00' },
  { id: '6f4e05a3-6083-4a30-ab28-f76f4e974efc', phone: '+240555879363', full_name: 'MOMA', password_hash: '$2a$10$KaNJni6.z4JiqWZ4bU.rwuT2MBN0TAlVXwys.57edXTm.vn1g7HEG', avatar_url: null, is_active: true, last_login: null, created_at: '2026-05-09 15:03:41.00129+00', updated_at: '2026-05-09 15:03:41.00129+00' },
  { id: 'd1b41bbf-d912-4c45-ba9d-9f9f9d903871', phone: '+240222041067', full_name: 'Lord Jordan', password_hash: '$2a$10$8wVXtJsaR5Pxqwhfpy.jfeEfAOOY2QlDP3AZOJtKFfjzHJiJi7Mgq', avatar_url: null, is_active: true, last_login: null, created_at: '2026-05-19 13:56:23.877842+00', updated_at: '2026-05-19 13:56:23.877842+00' },
  { id: 'abb817d1-84c5-496b-ac92-5305335a84e6', phone: '+240222027072', full_name: 'Tiny Abaga', password_hash: '$2a$10$cQsc0jP0UpyR5LkRjzd9qu126eQMxE4ux4EXJdCKJGJczhMt331Ei', avatar_url: null, is_active: true, last_login: null, created_at: '2026-05-22 09:07:36.297261+00', updated_at: '2026-05-22 09:07:36.297261+00' },
  { id: '33001253-c61f-466d-b5f0-cb30183a70af', phone: '+240222111111', full_name: 'Kukito ', password_hash: '$2a$10$wsCdp/2uvMV0nKa83gWkieYbEdnIZPYEsI/bGNb3hifQ5QISwz/ZK', avatar_url: null, is_active: true, last_login: '2026-06-01 21:22:11.273+00', created_at: '2026-05-24 23:09:24.45771+00', updated_at: '2026-06-01 21:22:11.312724+00' },
  { id: '9cd2fd0e-cd14-42dd-a742-3e0cc92d7703', phone: '+240999000001', full_name: 'Test User', password_hash: '$2a$10$ANPyGnFRuE9aHh2YVWBKzOuk3jQAFC1MESE6GUaainZN8iJjfGi6W', avatar_url: null, is_active: true, last_login: null, created_at: '2026-05-25 10:50:32.530667+00', updated_at: '2026-05-25 10:50:32.530667+00' },
];

async function importUsers() {
  const client = new Client({ connectionString: NEON_URL });
  try {
    console.log('Conectando a Neon...');
    await client.connect();
    console.log('Conectado OK');

    let imported = 0;
    let skipped = 0;

    for (const u of users) {
      try {
        await client.query(`
          INSERT INTO users (id, phone, full_name, password_hash, avatar_url, is_active, last_login, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (id) DO NOTHING
        `, [
          u.id,
          u.phone,
          u.full_name,
          u.password_hash,
          u.avatar_url,
          u.is_active,
          u.last_login || null,
          u.created_at,
        ]);
        imported++;
        console.log(`✓ ${u.full_name} (${u.phone})`);
      } catch (err) {
        console.error(`✗ Error con ${u.full_name}: ${err.message}`);
        skipped++;
      }
    }

    console.log(`\nImportados: ${imported} usuarios`);
    console.log(`Omitidos: ${skipped}`);

    // Crear wallets para los usuarios que no tengan
    console.log('\nCreando wallets...');
    const res = await client.query(`SELECT id FROM users`);
    for (const row of res.rows) {
      await client.query(`
        INSERT INTO wallets (user_id, balance, currency)
        VALUES ($1, 5000, 'XAF')
        ON CONFLICT (user_id) DO NOTHING
      `, [row.id]);
    }
    console.log(`Wallets creados para ${res.rows.length} usuarios`);

    // Verificar
    const count = await client.query('SELECT COUNT(*) FROM users');
    console.log(`\nTotal usuarios en Neon: ${count.rows[0].count}`);

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

importUsers();
