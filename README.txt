BOMBER TANKS — SOCKET.IO MULTIPLAYER PATCH

FILES
- index.html: original game UI with multiplayer and wallet-rule fixes
- server.js: Express + Socket.IO server
- package.json: Node.js dependencies and start command
- README.txt: setup and limitations

DEPLOY TO RENDER
1. Upload/extract all four files into the root of the GitHub repository.
2. In Render, create/open a Web Service connected to that repository.
3. Build Command: npm install
4. Start Command: npm start
5. Deploy, then open the Render URL on two devices or one normal + one incognito browser.
6. Check /health; it should return {"ok":true,"players":...}.

IMPORTANT GAMEPLAY CHANGES
- The server records online bombs and checks bomb ownership, fuse timing, hit distance, and wallet eligibility before relaying an online PvP hit.
- A player with a zero wallet can stay online and continue fighting bots, but their bombs cannot damage online players and they cannot earn online PvP rewards while their balance is zero.
- Online PvP rewards are issued through the server after a validated hit/life-loss confirmation, not from the local bot-damage routine.
- Admin broadcast/direct messages and bonuses can reach matching players who are currently connected to the game. Maintenance state is broadcast to connected game clients.
- Shared camera remains enabled. Different screen sizes/aspect ratios can show different edges of the map.

IMPORTANT LIMITATIONS — PLEASE READ
- This is still a prototype, not a production-secure wallet/account system. Existing registered accounts, login credentials, balances, recharge/withdrawal records, and most admin tables are stored in each browser's localStorage. This package does NOT create a shared persistent account database, so accounts made on another device may still not appear in the admin table.
- Server player/balance information is held in RAM and is lost when the Render process restarts or redeploys. Messages/bonuses are for online players only; offline delivery and durable account balances are not implemented.
- The current client login is not verified by the server, and admin socket actions are not protected by server-side authentication. Client-reported balances can be manipulated. Do not use real money or valuable balances with this version.
- To safely support persistent shared accounts, admin records, recharges/transfers, and authoritative wallets, the next step is a database-backed backend (for example PostgreSQL) with server-side account authentication and admin authorization.
- Do not open index.html directly from the tablet's Files app. It must be served from the deployed Node/Socket.IO server.
