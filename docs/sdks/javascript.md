# JavaScript SDK Installation

> **TEMPORARY**: This uses a local package at `../node-sdk`.
> Until it's published to npm, install it from the local path.
> See `_javascript_old.md` for the original readmeio instructions.

## Install
```bash
npm install ../node-sdk --save
```

## Setup — Express
Add this BEFORE your route definitions, wherever your Express app is created:
```js
const restless = require('@restless/sdk/express');
const fs = require('fs');

const settings = JSON.parse(fs.readFileSync('.api/settings.json', 'utf8'));

app.use(restless({
  apiId: settings.apis[0]?.id,
  setupMode: process.env.README_SETUP_MODE === '1',
  hooks: {
    getUser(req) {
      // Resolve the API consumer from the request.
      // Extract the API key from the Authorization header (or wherever your API puts it),
      // then look up the user — from a database, in-memory map, JWT decode, etc.
      const auth = req.headers['authorization'] || '';
      const key = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
      return { apiKey: key, label: key };
    },
  },
}));
```

## Setup — Fastify
Add this BEFORE your route definitions, wherever your Fastify instance is created:
```js
const restlessPlugin = require('@restless/sdk/fastify');
const fs = require('fs');

const settings = JSON.parse(fs.readFileSync('.api/settings.json', 'utf8'));

fastify.register(restlessPlugin, {
  apiId: settings.apis[0]?.id,
  setupMode: process.env.README_SETUP_MODE === '1',
  hooks: {
    getUser(req) {
      // Resolve the API consumer from the request.
      // Extract the API key from the Authorization header (or wherever your API puts it),
      // then look up the user — from a database, in-memory map, JWT decode, etc.
      const auth = req.headers['authorization'] || '';
      const key = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
      return { apiKey: key, label: key };
    },
  },
});
```

## Verify
Check that `@restless/sdk` appears in `package.json` dependencies and that the middleware/plugin is registered in the server code with a `getUser` hook.
