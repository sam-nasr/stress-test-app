# Load Tester App

A standalone local GUI for running k6 stress tests against any API endpoint.

## Prerequisites

Install k6 and make sure the `k6` command is available on your PATH.

- k6 installation guide: https://k6.io/docs/get-started/installation/
- Node.js 18 or newer

## Run

```bash
npm install
npm start
```

Open:

```text
http://localhost:4000
```

The server binds to `localhost:4000` only.

## Example Config For Your Go API

```text
baseUrl: http://localhost:8080
loginUrl: /auth/login
email: s3@ss.com
password: password
endpoint: /users?page=1&limit=10
```

Use `Auth enabled` if the endpoint requires a bearer token. By default, the app expects the login response token at:

```text
data.token
```

Generated k6 HTML dashboard reports are saved in `reports/` and can be opened from the report link after a test finishes.

## Notes

- The backend uses `child_process.spawn` with an argument array, not `exec`.
- User input is written into a generated k6 script as JSON data.
- Supported endpoint methods are `GET`, `POST`, `PUT`, and `DELETE`.
- Non-GET requests send the Body JSON as the request payload.
