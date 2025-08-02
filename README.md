# Stock Price Estimator ![Static Badge](https://img.shields.io/badge/html-python-blue)

This project provides a web application for estimating stock prices using a Discounted Cash Flow (DCF) model and offers financial insights for various companies. The application features user authentication, saving and loading of calculations, and interactive charts for financial data visualization.

## Features

* **User Authentication:** Secure login and registration using email/password and Google Sign-In (powered by Firebase Authentication).

* **DCF Calculator:**

  * Estimate stock prices based on Earnings Per Share (EPS) or Free Cash Flow (FCF) models.

  * Input custom growth rates, PE multiples, or FCF yields.

  * Calculate projected price after 5 years, desired return, and entry price for desired return.

  * Visualize projected price growth with interactive charts.

* **Financial Insights:**

  * View historical price data (all-time).

  * Analyze annual and quarterly financial statements (Revenue, Free Cash Flow, EPS, Net Income, EBITDA, Dividends) with interactive charts.

  * Full-screen chart viewing for detailed analysis.

* **Data Persistence:**

  * Save and load your DCF calculations (stored in Firestore).

  * Delete saved calculations.

* **Responsive Design:** User interface adapts to various screen sizes.

* **Toast Notifications:** Provides user feedback for actions and errors.

## Technologies Used

### Frontend

* **HTML5:** Structure of the web application.

* **CSS3 (Tailwind CSS):** For modern and responsive styling.

* **JavaScript (ES6+):** Core logic and interactivity.

* **Chart.js:** For rendering interactive financial charts.

* **Firebase SDK (v11.6.1):**

  * **Firebase Authentication:** User registration, login (email/password, Google Sign-In), and session management.

  * **Firebase Firestore:** Database for saving and loading user calculations.

### Backend

* **Python (Flask):** Web framework for handling API requests.

* **`yfinance`:** Python library to fetch historical market data, financial statements, and company information from Yahoo Finance.

* **`flask-cors`:** Enables Cross-Origin Resource Sharing for frontend-backend communication.

* **`firebase-admin`:** Python SDK for Firebase Admin, used to verify Firebase ID tokens and interact with Firestore.

* **`flask-limiter`:** For rate-limiting API requests to prevent abuse.

* **`pandas`:** Data manipulation and analysis.

## Project Structure

```
.
├── index.html          # Frontend: Main HTML file with all UI and JavaScript logic
├── readme.md           # This file
├── DCF_Backend.py      # Backend: Flask application with API endpoints
└── requirements.txt    # Requirements file
```

## Getting Started

Follow these steps to set up and run the project.

### Firebase Setup

1. **Create a Firebase Project:**

   * Go to the [Firebase Console](https://console.firebase.google.com/).

   * Click "Add project" and follow the steps to create a new project.

2. **Enable Authentication Methods:**

   * In your Firebase project, navigate to **Build > Authentication**.

   * Go to the "Sign-in method" tab.

   * Enable **Email/Password** and **Google** sign-in providers.

3. **Set up Firestore Database:**

   * In your Firebase project, navigate to **Build > Firestore Database**.

   * Click "Create database". Choose "Start in production mode" (you'll set up rules later).

   * Select a Cloud Firestore location.

   * **Firestore Security Rules:** Update your Firestore rules to allow authenticated users to read/write their own data. Go to the "Rules" tab and replace the default rules with:

     ```firestore
     rules_version = '2';
     service cloud.firestore {
       match /databases/{database}/documents {
         // User-specific calculations
         match /users/{userId}/calculations/{calcId} {
           allow read, write: if request.auth != null && request.auth.uid == userId;
         }
         // Add any other collections you might introduce later with appropriate rules
       }
     }
     ```

     Publish these rules.

4. **Get Firebase Web App Configuration:**

   * In your Firebase project, go to "Project settings" (gear icon next to "Project overview").

   * Scroll down to "Your apps" and click the web icon (`</>`) to add a new web app.

   * Register your app and copy the `firebaseConfig` object.

5. **Update Frontend `index.html`:**

   * Open `index.html`.

   * Locate the `firebaseConfig` object within the `<script type="module">` tag.

   * Replace the placeholder `firebaseConfig` with the one you copied from the Firebase Console.

   ```javascript
   const firebaseConfig = {
       apiKey: "YOUR_API_KEY",
       authDomain: "YOUR_AUTH_DOMAIN",
       projectId: "YOUR_PROJECT_ID",
       storageBucket: "YOUR_STORAGE_BUCKET",
       messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
       appId: "YOUR_APP_ID",
       measurementId: "YOUR_MEASUREMENT_ID" // Optional
   };
   ```

6. **Generate Firebase Service Account Key (for Backend):**

   * In your Firebase project, go to "Project settings" > "Service accounts".

   * Click "Generate new private key" and then "Generate key".

   * A JSON file will be downloaded. **Keep this file secure.**

### Backend Setup (Python Flask on Render)

The backend is a Python Flask application hosted on Render.

1. **Prepare your `DCF_Backend.py` file:**

   * Ensure your `DCF_Backend.py` file has the Firebase Admin SDK initialization logic as provided in the uploaded file, which reads the service account key from an environment variable.

2. **Create a `requirements.txt` file:**

   * In the same directory as `DCF_Backend.py`, create a file named `requirements.txt` with the following content:

     ```
     Flask==2.3.2
     yfinance==0.2.32
     Flask-Cors==3.0.10
     pandas==2.0.3
     firebase-admin==6.2.0
     PyJWT==2.8.0
     requests==2.31.0
     Flask-Limiter==3.5.1
     ```

     *(Note: Versions are suggestions; you might need to adjust based on compatibility.)*

3. **Deploy to Render:**

   * **Sign up/Log in to Render:** Go to [Render.com](https://render.com/) and create an account or log in.

   * **New Web Service:** Click "New" > "Web Service".

   * **Connect Git Repository:** Connect your Git repository (GitHub, GitLab, Bitbucket) where you've pushed your project files (`DCF_Backend.py`, `requirements.txt`).

   * **Configuration:**

     * **Name:** Choose a name for your service (e.g., `dcf-backend`).

     * **Region:** Select a region close to your users.

     * **Branch:** `main` (or your default branch).

     * **Root Directory:** Leave empty if your files are at the root, or specify the subdirectory if they are nested.

     * **Runtime:** `Python 3`

     * **Build Command:** `pip install -r requirements.txt`

     * **Start Command:** `gunicorn DCF_Backend:app` (assuming your Flask app instance is named `app` in `DCF_Backend.py`).

     * **Instance Type:** Choose a suitable instance type (e.g., `Free` for testing).

   * **Environment Variables:** This is crucial for your Firebase Service Account Key.

     * Open the JSON file you downloaded from Firebase (Service Accounts).

     * Copy the entire content of the JSON file.

     * Go to the "Environment" section in Render's service settings.

     * Add a new environment variable:

       * **Key:** `FIREBASE_SERVICE_ACCOUNT_KEY_BASE64`

       * **Value:** Paste the entire JSON content, then encode it to Base64. You can use an online Base64 encoder (e.g., [base64encode.org](https://www.base64encode.org/)) or a Python script:

         ```python
         import base64
         import json
         
         # Replace with the actual content of your Firebase service account JSON file
         service_account_json_content = """
         {
           "type": "service_account",
           "project_id": "your-project-id",
           "private_key_id": "...",
           "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
           "client_email": "...",
           "client_id": "...",
           "auth_uri": "...",
           "token_uri": "...",
           "auth_provider_x509_cert_url": "...",
           "client_x509_cert_url": "...",
           "universe_domain": "..."
         }
         """
         
         encoded_key = base64.b64encode(service_account_json_content.encode('utf-8')).decode('utf-8')
         print(encoded_key)
         ```

         Paste the resulting Base64 string as the value for `FIREBASE_SERVICE_ACCOUNT_KEY_BASE64`.

   * **Create Web Service:** Click "Create Web Service". Render will now build and deploy your application.

4. **Get Backend URL:**

   * Once deployed, Render will provide you with a public URL for your backend service (e.g., `https://your-service-name.onrender.com`).

5. **Update Frontend `index.html` with Backend URL:**

   * Open `index.html`.

   * Locate the `backendBaseUrl` variable:

     ```javascript
     const backendBaseUrl = 'https://dcf-backend.onrender.com'; // Update this URL
     ```

   * Replace the placeholder URL with your actual Render backend URL.

### Frontend Setup (HTML/CSS/JS)

The frontend is a static HTML file.

1. **No Server Required:** Since `index.html` is a self-contained file with all CSS and JavaScript, you can open it directly in your web browser.

2. **Live Server (Recommended for Development):** For local development, you can use a simple HTTP server like Python's `http.server` or the Live Server extension in VS Code.

   * **Python:** Navigate to your project directory in the terminal and run:

     ```bash
     python -m http.server
     ```

     Then open `http://localhost:8000/index.html` in your browser.

## Usage

1. **Access the Application:** Open `index.html` in your web browser (or the deployed URL if you've hosted it).

2. **Login/Register:**

   * If you're a new user, click "Register" to create an account using email/password or "Sign in with Google".

   * If registering with email, check your email for a verification link. You must verify your email to log in.

   * Log in with your credentials.

3. **Main Menu:** After logging in, you'll see the main menu with options for "DCF Calculator" and "Insights".

4. **DCF Calculator:**

   * Enter a stock ticker symbol (e.g., `GOOG`, `MSFT`).

   * Click "Search" to fetch current metrics.

   * Choose between "Earnings" or "Cash Flow" tabs for your assumptions.

   * Adjust the input fields (Growth Rate, PE Multiple/FCF Yield, Desired Return).

   * Click "Calculate" to see the projected price and returns.

   * Click "Save" to save your calculation (you'll be prompted for a name).

   * Click "Load" to view and load previously saved calculations.

5. **Insights:**

   * Enter a stock ticker symbol.

   * Click "Get Insights" to fetch historical price and financial statement data.

   * Toggle between "Annual" and "Quarterly" data.

   * Click on any chart to view it in full-screen mode.

6. **Logout:** Click "Logout" from the main menu to sign out.

## API Endpoints

The backend Flask application exposes the following endpoints:

* **`GET /get_trailing_metrics?ticker=<TICKER_SYMBOL>`**

  * **Description:** Fetches trailing 12-month (TTM) financial metrics (EPS, PE, FCF/Share, FCF Yield, SBC Impact) and current stock price for a given ticker.

  * **Authentication:** Requires Firebase ID Token.

  * **Rate Limit:** 60 requests per minute.

  * **Example:** `/get_trailing_metrics?ticker=GOOG`

* **`GET /get_insights_data?ticker=<TICKER_SYMBOL>`**

  * **Description:** Retrieves historical price data, annual, and quarterly financial statements (Revenue, FCF, EPS, Net Income, EBITDA, Dividends) for charting.

  * **Authentication:** Requires Firebase ID Token.

  * **Rate Limit:** 30 requests per minute.

  * **Example:** `/get_insights_data?ticker=MSFT`

* **`POST /save_calculation`**

  * **Description:** Saves a user's DCF calculation data to Firestore.

  * **Authentication:** Requires Firebase ID Token.

  * **Request Body (JSON):**

    ```json
    {
        "ticker": "AAPL",
        "name": "My Apple DCF",
        "data": { /* ... (captured calculation data from frontend) ... */ }
    }
    ```

* **`GET /load_calculations`**

  * **Description:** Loads the last 10 saved DCF calculations for the authenticated user from Firestore.

  * **Authentication:** Requires Firebase ID Token.

* **`DELETE /delete_calculation/<calc_id>`**

  * **Description:** Deletes a specific saved calculation by its ID from Firestore.

  * **Authentication:** Requires Firebase ID Token.

  * **Example:** `/delete_calculation/My Apple DCF`

## License

This project is open-source and available under the [MIT License](https://www.google.com/search?q=LICENSE)
