import path from 'path';

// Override for local dev with `RESTLESS_SITE_URL=http://localhost:4099 npx api setup`.
export const SITE_URL = process.env.RESTLESS_SITE_URL || 'https://app.restless.ai';
export const CALENDLY_URL = 'https://calendly.com/[tbd]';

// How the user invoked us (e.g. "api", "api-beta"), derived from argv[1] so output
// matches whatever bin name shipped — no hardcoding the package name in user-facing strings.
export const CLI_NAME = path.basename(process.argv[1] || '', '.js') || 'api';
