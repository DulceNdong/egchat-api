// import-wallets-neon.cjs — Importa wallets de Supabase a Neon con balances reales
const { Client } = require('pg');

const NEON_URL = 'postgresql://neondb_owner:npg_QGsC87gwTEbL@ep-icy-smoke-a2znhutu.eu-central-1.aws.neon.tech/neondb?sslmode=require';

const wallets = [
  { id: '7741102f-54a5-4284-bb6d-dba41563041b', user_id: 'ccfbcbe3-3a22-4eb8-b1f8-c3b2387b224a', balance: 5000.00, currency: 'XAF', created_at: '2026-04-10 14:03:48.760198+00' },
  { id: '55f47461-a02e-4347-8056-81796476310b', user_id: 'dadd0b54-48ee-47ca-83c1-2ae5e48ed787', balance: 5000.00, currency: 'XAF', created_at: '2026-04-10 15:17:39.783188+00' },
  { id: '4c99c08c-06a3-45df-a59e-dad319f0d9f2', user_id: 'f1c4a458-862b-4317-8008-cb344d69b543', balance: 5000.00, currency: 'XAF', created_at: '2026-04-10 17:40:51.633232+00' },
  { id: 'b235a461-24a8-496c-a0c8-69627fb6d8f2', user_id: '4bd2598a-ffa9-4614-822b-58201061b5ea', balance: 5000.00, currency: 'XAF', created_at: '2026-04-12 16:48:52.340592+00' },
  { id: '416a2408-0d46-404b-a0af-e619234cd4fd', user_id: '90e2b172-55d1-4708-a8c9-56f7dd59a718', balance: 5000.00, currency: 'XAF', created_at: '2026-04-12 17:35:46.946871+00' },
  { id: '83eeb857-1785-48ed-a185-222ded1cc334', user_id: 'fdc21eab-c7ef-457e-ba0a-2985a2c0366b', balance: 5000.00, currency: 'XAF', created_at: '2026-04-12 18:17:12.923367+00' },
  { id: '35372412-c7a2-4129-8157-1b92a1d4d35c', user_id: '1338fe25-9826-45f6-adfe-3b46268fa81d', balance: 5000.00, currency: 'XAF', created_at: '2026-04-13 16:07:38.879366+00' },
  { id: 'e1b6a66a-427f-46bd-b074-78e58d7b4b17', user_id: 'ad498f0c-8870-41a1-bd09-2c30392b82a6', balance: 5000.00, currency: 'XAF', created_at: '2026-04-17 08:18:19.02215+00' },
  { id: 'ed026094-0f5a-4999-bf7d-4bfb8fc546f0', user_id: '1f804b4d-20c8-4e36-bd47-eb4195738ddb', balance: 5000.00, currency: 'XAF', created_at: '2026-04-17 08:24:37.636212+00' },
  { id: '8dc20732-dc5f-4905-94f2-765443af7011', user_id: '5c893eb5-689f-4d1f-8082-50c763a3b4cf', balance: 5000.00, currency: 'XAF', created_at: '2026-04-17 08:44:00.07764+00' },
  { id: 'cf2c1761-2f7d-4e66-91ca-5238df2d2b05', user_id: 'f826ee89-6af9-4561-86fd-ee7154495cb1', balance: 5000.00, currency: 'XAF', created_at: '2026-04-17 08:44:57.170239+00' },
  { id: 'c3868d2b-a8d4-4a98-9688-48b986e7f88c', user_id: '35fbe886-82ba-4d2c-ad1a-15d1f29926fe', balance: 5000.00, currency: 'XAF', created_at: '2026-04-17 09:17:57.39739+00' },
  { id: '53ffaa3b-026f-48e6-aaec-fc94ac3434df', user_id: '07c561ed-3762-4540-b005-59b04e3340b4', balance: 5000.00, currency: 'XAF', created_at: '2026-04-17 10:39:45.387381+00' },
  { id: 'dd316166-4f7d-420e-a553-09b2b9bce488', user_id: '93c8a2af-1fab-4ad0-ad18-b641a34a784d', balance: 5000.00, currency: 'XAF', created_at: '2026-04-17 15:04:05.246289+00' },
  { id: 'aae63b15-cda2-48c8-82fa-1ea2de4b7872', user_id: '044b2e01-2565-43a6-86bd-b019dabb7d29', balance: 5000.00, currency: 'XAF', created_at: '2026-04-17 18:45:01.597028+00' },
  { id: 'e0ab97af-cec3-4289-8f56-985ac33deb04', user_id: '06435b21-0589-4b76-84c1-fc5e8889f78b', balance: 5000.00, currency: 'XAF', created_at: '2026-04-17 19:31:24.038287+00' },
  { id: '86c4ee53-eb69-45d5-8fde-7bb8f76483f3', user_id: '40195907-4218-4986-b25b-41925e5ef6ca', balance: 5000.00, currency: 'XAF', created_at: '2026-04-18 20:45:01.668827+00' },
  { id: '5975ea62-2fa5-4d46-ba3d-8bbcd61efd77', user_id: '5e394b94-cf58-49ad-a527-5c805d5f8283', balance: 5000.00, currency: 'XAF', created_at: '2026-04-19 10:05:24.310448+00' },
  { id: 'cfb11324-4d84-4b1a-9a76-2a659b7d339d', user_id: '0989d96b-ccf4-49d2-aa0f-7bf5a5273966', balance: 5000.00, currency: 'XAF', created_at: '2026-04-20 18:57:08.047101+00' },
  { id: 'fa5f1a07-2e78-421d-9385-fd53f699233a', user_id: 'bf337153-8a7e-4d8b-ab68-3e6e9e3b5f46', balance: 5000.00, currency: 'XAF', created_at: '2026-04-23 10:53:30.328568+00' },
  { id: 'e8fba08a-be1e-4d20-827c-606f0bf83553', user_id: '4953e041-f1cd-44d0-bc24-1cdc63e47d2e', balance: 5000.00, currency: 'XAF', created_at: '2026-04-25 11:03:11.143028+00' },
  { id: 'b199c466-6349-4053-91b0-4329f6bd440a', user_id: '94f8e3f4-8181-45ad-9c99-46e3c8437c88', balance: 5000.00, currency: 'XAF', created_at: '2026-04-26 18:12:42.173768+00' },
  { id: 'c37703b0-5950-46a6-a24e-a1772ac69356', user_id: 'f6778a36-1c3d-4b2d-a519-f01d9f392d92', balance: 5000.00, currency: 'XAF', created_at: '2026-04-26 18:38:10.866495+00' },
  { id: 'c499a0b4-623f-4b7a-9b50-9cd8679e36b8', user_id: '32dd1fa7-977a-4be8-b6a8-b7ff3cd0185c', balance: 5000.00, currency: 'XAF', created_at: '2026-04-26 19:11:11.351872+00' },
  { id: 'e5dc0834-0bac-4ae5-94ef-6c8ada0bc690', user_id: '8b37fea7-aa85-443e-96c8-fe765b4e858c', balance: 5000.00, currency: 'XAF', created_at: '2026-04-27 10:05:10.658479+00' },
  { id: 'e84f00da-0a0b-43d7-8684-1f3743b9bfc0', user_id: '17be01f2-5a9b-4c86-a819-cb2b4e8e0415', balance: 5000.00, currency: 'XAF', created_at: '2026-04-27 10:17:54.533799+00' },
  { id: 'b44ef058-8aeb-4030-8a55-0f51bea9605f', user_id: 'd7e8ae97-df4e-4e2e-876e-0740e1f2d2b6', balance: 5000.00, currency: 'XAF', created_at: '2026-04-27 10:22:01.141134+00' },
  { id: '92cd345f-06d7-445d-9cd8-14313b09eee3', user_id: 'f67509de-6729-4737-b9d2-72decfd52f2b', balance: 5000.00, currency: 'XAF', created_at: '2026-04-27 10:25:28.637868+00' },
  { id: '6de1d9ca-0cb1-440b-8cc9-a7ce86610006', user_id: '3dc4e621-24a1-40b0-ba32-7d48eed8eb14', balance: 5000.00, currency: 'XAF', created_at: '2026-04-28 22:21:09.119782+00' },
  { id: '66b8f88e-85f2-481e-ba81-6facf2ae5e13', user_id: '0a0c36ef-b048-4383-b9b0-4aeebdf54459', balance: 5000.00, currency: 'XAF', created_at: '2026-05-03 13:05:52.048262+00' },
  { id: '2306c14c-32b1-498c-8946-0fa2026e7895', user_id: 'a150e706-3dd1-440a-8a11-0d0afdd59f9a', balance: 5000.00, currency: 'XAF', created_at: '2026-05-03 13:06:57.425961+00' },
  { id: '21fc6570-6ec0-480e-991e-22120e44ca1a', user_id: '5ac9d45a-7663-4c21-b467-99d1f7491f6e', balance: 5000.00, currency: 'XAF', created_at: '2026-05-08 12:58:02.06948+00' },
  { id: 'f548ac7a-4527-493b-a351-0f2628fba0d9', user_id: '6f4e05a3-6083-4a30-ab28-f76f4e974efc', balance: 5000.00, currency: 'XAF', created_at: '2026-05-09 15:03:41.00129+00' },
  { id: 'a7a34caf-6429-4743-8fb8-7c748575b946', user_id: 'd1b41bbf-d912-4c45-ba9d-9f9f9d903871', balance: 5000.00, currency: 'XAF', created_at: '2026-05-19 13:56:23.877842+00' },
  { id: '114a688c-6184-4f83-85bc-50c4adca8ee1', user_id: 'abb817d1-84c5-496b-ac92-5305335a84e6', balance: 5000.00, currency: 'XAF', created_at: '2026-05-22 09:07:36.297261+00' },
  { id: 'ea3aa585-e303-4fd0-ba09-8afdcdd4f2dc', user_id: '33001253-c61f-466d-b5f0-cb30183a70af', balance: 5000.00, currency: 'XAF', created_at: '2026-05-24 23:09:24.45771+00' },
  { id: '9009988c-4e57-4cba-8615-068956bd42e7', user_id: '9cd2fd0e-cd14-42dd-a742-3e0cc92d7703', balance: 5000.00, currency: 'XAF', created_at: '2026-05-25 10:50:32.530667+00' },
];

async function importWallets() {
  const client = new Client({ connectionString: NEON_URL });
  try {
    console.log('Conectando a Neon...');
    await client.connect();
    console.log('Conectado OK\n');

    // Primero eliminar wallets auto-creados
    await client.query('DELETE FROM wallets');
    console.log('Wallets anteriores eliminados');

    let imported = 0;
    // Insertar de 5 en 5 para evitar timeout
    for (let i = 0; i < wallets.length; i++) {
      const w = wallets[i];
      try {
        await client.query(`
          INSERT INTO wallets (id, user_id, balance, currency, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $5)
          ON CONFLICT (id) DO UPDATE SET balance = $3
        `, [w.id, w.user_id, w.balance, w.currency, w.created_at]);
        imported++;
        if (imported % 5 === 0) console.log(`  ${imported} wallets...`);
      } catch (err) {
        console.error(`✗ Error wallet ${w.user_id}: ${err.message}`);
      }
    }
    console.log(`✓ ${imported} wallets importados`);

    const count = await client.query('SELECT COUNT(*) FROM wallets');
    console.log(`Total wallets en Neon: ${count.rows[0].count}`);

    const users = await client.query('SELECT COUNT(*) FROM users');
    console.log(`Total usuarios en Neon: ${users.rows[0].count}`);

    console.log('\n✅ Migración completa. La app está lista.');

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await client.end();
  }
}

importWallets();
