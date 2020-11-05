
1. Install node (if not installed already) https://nodejs.org/en/
2. Clone this repo from github
3. Make a .env file in root directory
4. Add your argon `DEVICE_KEY='xxxxxxxxxxxxxxx'` which you recieved after registering your device
5. Add `PARTICLE_TOKEN='xxxxxxxxxxxxxxx'` by opening the Particle CLI (in seismic-intercept project in VS Code) and run `particle token list` and copy the particle user token to your .env file
6. Add `LOCALHOST='4000'`
7. Open terminal and install dependancies and run `npm install && npm start`