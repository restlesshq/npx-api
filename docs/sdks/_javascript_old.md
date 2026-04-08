# JavaScript SDK Installation

## Install
```bash
npm install readmeio --save
```

## Setup
Add the server middleware and populate API request attributes, such as a user's email and API key.

```js
const readme = require('readmeio');

app.use((req, res, next) => {
  readme.log(process.env.README_API_KEY, req, res, {
    // User's API Key
    apiKey: 'owlbert-api-key',
    // Username to show in ReadMe's dashboard
    label: 'Owlbert',
    // User's email address
    email: 'owlbert@example.com',
  });
  return next();
});
```

## Verify
Check that `readmeio` appears in `package.json` dependencies and `node_modules/readmeio` exists.
