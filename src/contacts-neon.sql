INSERT INTO contacts (id, user_id, contact_user_id, phone, nickname, is_blocked, is_favorite, created_at) VALUES
('e7b5e56f-e8e3-4d92-8270-f58fe0d55a78','fdc21eab-c7ef-457e-ba0a-2985a2c0366b','f1c4a458-862b-4317-8008-cb344d69b543',null,'REDDINGTON',false,false,'2026-04-13 16:05:18.498612+00'),
('20ee06a8-ce8d-427f-91c0-b7eba06e0c13','1338fe25-9826-45f6-adfe-3b46268fa81d','f1c4a458-862b-4317-8008-cb344d69b543',null,'REDDINGTON',false,false,'2026-04-13 16:07:54.388892+00'),
('6c247947-baed-461f-b5b0-75f9a33e6e33','fdc21eab-c7ef-457e-ba0a-2985a2c0366b','90e2b172-55d1-4708-a8c9-56f7dd59a718',null,'santos ',false,false,'2026-04-13 16:47:36.447775+00'),
('1e8fe279-1de4-469f-9078-738ae420ebe1','f1c4a458-862b-4317-8008-cb344d69b543','93c8a2af-1fab-4ad0-ad18-b641a34a784d',null,'Benja',false,false,'2026-04-17 21:45:37.775879+00'),
('7f3640eb-df10-4da0-b223-4318684a23b0','90e2b172-55d1-4708-a8c9-56f7dd59a718','f1c4a458-862b-4317-8008-cb344d69b543',null,'REDDINGTON',false,false,'2026-04-16 16:53:13.384491+00'),
('a6b35651-3b95-4bae-a96c-75c3fcba6e76','f1c4a458-862b-4317-8008-cb344d69b543','ad498f0c-8870-41a1-bd09-2c30392b82a6',null,'Maribel Mikue',false,false,'2026-04-17 08:43:41.169834+00'),
('6904059d-3f1a-43dd-8151-fa6eab11ab02','f826ee89-6af9-4561-86fd-ee7154495cb1','f1c4a458-862b-4317-8008-cb344d69b543',null,'REDDINGTON',false,false,'2026-04-17 08:47:35.121929+00'),
('c5819750-03bf-45fc-9091-7faa6b14ee07','33001253-c61f-466d-b5f0-cb30183a70af','ccfbcbe3-3a22-4eb8-b1f8-c3b2387b224a',null,'E2E Flow',false,false,'2026-05-24 23:11:31.433843+00'),
('c6c7c32a-7cf8-4770-9ede-5f5c4c0804c8','f1c4a458-862b-4317-8008-cb344d69b543','5c893eb5-689f-4d1f-8082-50c763a3b4cf',null,'nnomo obiang',false,true,'2026-04-17 08:49:00.344503+00'),
('aeb5248a-847e-4e83-b94b-04a1ef7d2d13','33001253-c61f-466d-b5f0-cb30183a70af','d1b41bbf-d912-4c45-ba9d-9f9f9d903871',null,'Lord Jordan',false,false,'2026-05-24 23:11:32.150388+00')
ON CONFLICT (id) DO NOTHING;

INSERT INTO contacts (id, user_id, contact_user_id, phone, nickname, is_blocked, is_favorite, created_at) VALUES
('98fd8cf5-0896-430f-a3b7-f6eeb8b96c6f','f1c4a458-862b-4317-8008-cb344d69b543','4953e041-f1cd-44d0-bc24-1cdc63e47d2e',null,'Isidro Mba Obiang Avomo',false,false,'2026-04-25 20:42:07.500531+00'),
('f665bf97-3548-4ebd-8533-5152d466783d','07c561ed-3762-4540-b005-59b04e3340b4','f1c4a458-862b-4317-8008-cb344d69b543',null,'REDDINGTON',false,false,'2026-04-17 10:43:33.1263+00'),
('a68d3889-903e-4987-8379-03dc265ceba1','32dd1fa7-977a-4be8-b6a8-b7ff3cd0185c','f1c4a458-862b-4317-8008-cb344d69b543',null,'REDDINGTON',false,false,'2026-04-26 19:12:00.813836+00'),
('6cdaa079-cd86-40ac-a35c-460f4edcd54c','8b37fea7-aa85-443e-96c8-fe765b4e858c','f1c4a458-862b-4317-8008-cb344d69b543',null,'REDDINGTON',false,false,'2026-04-27 10:09:13.742144+00'),
('87e1f786-a05b-415f-94fc-d185c732117d','33001253-c61f-466d-b5f0-cb30183a70af','a150e706-3dd1-440a-8a11-0d0afdd59f9a',null,'Ibrahim',false,false,'2026-05-24 23:11:32.836406+00'),
('bb58fa20-325f-4c0d-a27a-13e84a48b356','33001253-c61f-466d-b5f0-cb30183a70af','d7e8ae97-df4e-4e2e-876e-0740e1f2d2b6',null,'Benjamin NZE',false,false,'2026-05-24 23:11:33.038031+00'),
('d34b8986-baba-4a4c-a346-176fc3be7b74','33001253-c61f-466d-b5f0-cb30183a70af','ad498f0c-8870-41a1-bd09-2c30392b82a6',null,'Maribel Mikue',false,false,'2026-05-24 23:11:33.145295+00'),
('7d7515c9-7de2-4e9e-923a-7dcf1d461b9e','a150e706-3dd1-440a-8a11-0d0afdd59f9a','94f8e3f4-8181-45ad-9c99-46e3c8437c88',null,'Miguel Edu',false,false,'2026-05-03 13:07:48.893678+00'),
('13189c5b-4e06-4675-be6c-88ff4a87dc0b','a150e706-3dd1-440a-8a11-0d0afdd59f9a','4bd2598a-ffa9-4614-822b-58201061b5ea',null,'charlis',false,false,'2026-05-03 13:07:49.313639+00'),
('c8c9529e-687c-4685-a7b1-38181c8d194e','f1c4a458-862b-4317-8008-cb344d69b543','17be01f2-5a9b-4c86-a819-cb2b4e8e0415',null,'Silvestre',false,false,'2026-04-27 11:54:40.490144+00')
ON CONFLICT (id) DO NOTHING;
