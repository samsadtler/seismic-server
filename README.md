
1. Install node (if not installed already) https://nodejs.org/en/
2. Clone this repo
3. Make a .env file in root directory
4. Add your argon `DEVICE_KEY='xxxxxxxxxxxxxxx'` which you recieved after registering your device
5. Geneate particle token `particle token create` defaults to 90 day expiration use flag  `--never-expires` for a long lived token
6. Add `PARTICLE_TOKEN='xxxxxxxxxxxxxxx'`
7. (Optional) Add `PORT='4000'` — the server reads `process.env.PORT` and defaults to `4000`. On Railway/other hosts, `PORT` is injected automatically, so leave it unset there.
8. Open terminal and install dependancies and run `npm install && npm start`

Env vars used: `DEVICE_KEY`, `PARTICLE_TOKEN`, `MAX_DURATION`, `MIN_DURATION`, `PORT` (optional).