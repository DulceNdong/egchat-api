const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_VERSION = process.env.APP_VERSION || require('./package.json').version || '2.5.1';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !process.env.JWT_SECRET) {
  console.error('ERROR: SUPABASE_URL, SUPABASE_SERVICE_KEY y JWT_SECRET deben estar configurados en el entorno.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const runUpdate = async () => {
  console.log(`Starting user version migration to ${APP_VERSION}`);

  const batchSize = 200;
  let updated = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: users, error: selectError } = await supabase
      .from('users')
      .select('id')
      .neq('app_version', APP_VERSION)
      .limit(batchSize);

    if (selectError) {
      console.error('ERROR selecting users:', selectError.message);
      process.exit(1);
    }

    if (!users || users.length === 0) {
      hasMore = false;
      break;
    }

    const ids = users.map((row) => row.id);
    const { error: updateError } = await supabase
      .from('users')
      .update({ app_version: APP_VERSION })
      .in('id', ids);

    if (updateError) {
      console.error('ERROR updating user versions:', updateError.message);
      process.exit(1);
    }

    updated += ids.length;
    if (users.length < batchSize) hasMore = false;
  }

  console.log(`Updated app_version for ${updated} users to ${APP_VERSION}.`);
  process.exit(0);
};

runUpdate();
