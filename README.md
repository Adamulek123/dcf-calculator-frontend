# Stock Price Estimator — Frontend

Static frontend for a Firebase-authenticated stock research application with DCF calculations, financial-data charts, saved valuations, and portfolio tracking.

> This repository is one half of the application. The Flask API is maintained in the separate [`Adamulek123/DCF_Calculator`](https://github.com/Adamulek123/DCF_Calculator) repository and is normally checked out locally as the sibling directory `../backend/`.

## Architecture

```text
Browser (this repository)
  ├─ Firebase Authentication
  └─ Bearer-token API requests
                │
                ▼
Flask API (../backend, deployed on Render)
  ├─ Yahoo Finance and Frankfurter market data
  └─ Firebase Admin / Cloud Firestore
```

The two codebases are independent Git repositories:

| Component | Repository | Default branch | Hosting |
| --- | --- | --- | --- |
| Frontend | [`Adamulek123/dcf-calculator-frontend`](https://github.com/Adamulek123/dcf-calculator-frontend) | `master` | Static GitHub-hosted site |
| Backend | [`Adamulek123/DCF_Calculator`](https://github.com/Adamulek123/DCF_Calculator) | `main` | Render: `https://dcf-backend.onrender.com` |
| Database and identity | Firebase project `dcf123-b6cb1` | — | Firebase Authentication and Cloud Firestore |

Changes to request or response formats often require coordinated changes and separate commits in both repositories.

## Features

- Email/password registration with email verification
- Google sign-in
- DCF valuation based on earnings or free cash flow
- Current market metrics and company information
- Historical prices and annual, quarterly, TTM, and segment financial charts
- Saving, loading, and deleting user DCF calculations
- Portfolio positions, live prices, leverage, and currency conversion
- Named Dip Finder watchlists with ranked period returns and drawdowns
- Responsive navigation, loading states, caching, and toast notifications

## Technology

- HTML5 and custom CSS
- Browser-native JavaScript ES modules
- [Chart.js](https://www.chartjs.org/) loaded from jsDelivr
- Firebase JavaScript SDK 11.6.1 for Authentication
- A separate Python/Flask API for data access and Firestore persistence

There is no Node.js package, bundler, or frontend build step.

## Project structure

```text
frontend/
├── index.html                 # Landing page
├── login.html                 # Sign-in page
├── register.html              # Registration page
├── dcf-calculator.html        # DCF calculator
├── financial-data.html        # Financial-data dashboard
├── portfolio-creator.html     # Portfolio tool and watchlist import
├── dip-finder.html            # Watchlist dip and drawdown scanner
├── css/
│   └── style.css              # Shared application styles
├── js/
│   ├── api.js                 # API URL and authenticated fetch wrapper
│   ├── auth.js                # Firebase sign-in and registration
│   ├── auth-guard.js          # Protected-page handling
│   ├── firebase-init.js       # Firebase web client configuration
│   ├── dcf-calculator.js      # DCF workflow
│   ├── financial-data.js      # Financial dashboard
│   ├── portfolio-creator.js   # Portfolio workflow and watchlist import
│   ├── dip-finder.js          # Watchlist CRUD and ranked performance chart
│   ├── charts.js              # Chart helpers
│   ├── cache.js               # Browser-side response cache
│   ├── ticker.js              # Ticker search and logos
│   ├── sidebar.js             # Shared navigation
│   └── toast.js               # Notifications
├── assets/                    # Images, SVGs, and animation frames
└── scripts/                   # Asset-processing utilities
```

## Local development

### 1. Check out both repositories

Keep the repositories beside one another so the paths match the documentation:

```bash
mkdir website
cd website
git clone https://github.com/Adamulek123/dcf-calculator-frontend.git frontend
git clone https://github.com/Adamulek123/DCF_Calculator.git backend
```

### 2. Run the backend

Follow the backend repository's README. By default it listens at `http://localhost:5000`.

### 3. Serve the frontend

Pages must be served over HTTP for ES modules and authentication flows to work reliably:

```bash
cd frontend
python -m http.server 8000
```

Open `http://localhost:8000/`.

`js/api.js` automatically selects:

- `http://localhost:5000` on `localhost` or `127.0.0.1`
- `https://dcf-backend.onrender.com` on other hosts

On localhost, js/firebase-init.js connects Firebase Authentication to http://127.0.0.1:9099. The backend's documented python 123.py entrypoint now enables matching Auth and Firestore emulator hosts automatically. Start both emulators before testing:

    firebase emulators:start --only auth,firestore --project dcf123-b6cb1

This keeps local watchlist and portfolio writes out of production Firestore.

## Authentication and data flow

The frontend uses Firebase Authentication only. After sign-in, `js/api.js` obtains the current user's Firebase ID token and sends it as:

```http
Authorization: Bearer <firebase-id-token>
```

Saved calculations, portfolios, and financial datasets are read or written by the Flask backend through the Firebase Admin SDK. The browser does not directly perform those Firestore operations.

The Firebase web configuration in `js/firebase-init.js` identifies the public web client and is not a service-account secret. Firebase Admin credentials and private keys must never be added to this repository.

## Backend API used by the frontend

All feature endpoints require an Authorization bearer token.

| Method | Route | Used for |
| --- | --- | --- |
| `GET` | `/get_trailing_metrics?ticker=...` | DCF inputs and trailing metrics |
| `GET` | `/get_market_price?ticker=...` | Current and historical prices |
| `GET` | `/get_basic_data?ticker=...` | Stored financial statement data |
| `GET` | `/get_segment_data?ticker=...` | Stored segment data |
| `GET` | `/get_ttm_data?ticker=...` | Stored trailing-twelve-month data |
| `GET` | `/get_ttm_segment_data?ticker=...` | Stored TTM segment data |
| `GET` | `/get_stock_info_data?ticker=...` | Company and valuation metrics |
| `GET` | `/get_tickers` | Ticker search dataset |
| `POST` | `/save_calculation` | Save a named DCF calculation |
| `GET` | `/load_calculations` | Load the user's latest calculations |
| `DELETE` | `/delete_calculation/<id>` | Delete one saved calculation |
| `POST` | `/portfolio/save` | Save the user's default portfolio |
| `GET` | `/portfolio/load` | Load the user's default portfolio |
| `POST` | `/portfolio/current-prices` | Fetch prices for portfolio tickers |
| `GET` | `/portfolio/conversion-rates?base=USD` | Fetch currency conversion rates |
| GET | /watchlists | Load the current user's watchlists |
| POST | /watchlists | Create a normalized watchlist |
| PATCH | /watchlists/<id> | Rename a watchlist or replace its ticker roster |
| POST | /watchlists/<id>/tickers | Merge unique portfolio tickers into a watchlist |
| DELETE | /watchlists/<id> | Delete one watchlist |
| POST | /watchlists/performance | Return all Dip Finder period metrics in one bulk response |

The backend README is the source of truth for server behavior and Firestore paths.

Dip Finder uses adjusted daily closes. Return compares the latest close with the last close on or before the selected boundary; drawdown compares it with the highest close in that window. Watchlists are limited to 20 per user and 50 unique validated tickers each.

## Deployment notes

- The frontend is static and can be hosted directly from its GitHub repository.
- The production API origin is configured in `js/api.js`.
- Every HTML page has a Content Security Policy. If the API URL or another external service changes, update the relevant CSP directives as needed.
- The Render service may need time to wake from an idle state; frontend error and loading states should account for network delays.

## Verification

There is currently no automated frontend test suite. Before committing a change:

1. Serve the site over HTTP.
2. Check the browser console for module and CSP errors.
3. Test signed-out redirects and an authenticated session.
4. Inspect affected requests in the browser Network panel.
5. For API-contract changes, test the matching backend route and check both repositories separately.
