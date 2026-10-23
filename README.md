# ShelfSense: website + working backend

Your landing page, a login-protected dashboard, and a real database, all in one small project.
No installation of extra packages is needed.

## How to run it (5 minutes)

1. Install Node.js (the "LTS" version) from https://nodejs.org. It must be version 22.13 or newer.
2. Unzip this folder.
3. Open a terminal inside the folder:
   - Windows: open the folder, click the address bar, type `cmd`, press Enter.
   - Mac: right-click the folder and choose "New Terminal at Folder".
4. Type this and press Enter:

       node server.js

5. Open http://localhost:3000 in your browser.

Log in at http://localhost:3000/app with the demo account:
**demo@shelfsense.in** / **demo1234** (or create your own account).
Press Ctrl+C in the terminal to stop the server.

## What it does

- Accounts with hashed passwords. Each shop sees only its own data.
- Products: add, edit, delete, restock.
- Selling reduces stock and records the sale. You can't sell more than you have.
- Dashboard: stock value, today's sales and profit, low-stock alerts, expiry alerts (next 7 days), 7-day sales chart.
- Data is saved in the file `shelfsense.db`. Back that file up. Delete it to start fresh.

## API (for developers)

All `/api` routes except login and register need the header `Authorization: Bearer <token>`.

| Method | Route | Purpose |
|---|---|---|
| POST | /api/register | `{name,email,password}` returns a token |
| POST | /api/login | `{email,password}` returns a token |
| GET | /api/products | list products |
| POST | /api/products | `{name,price,cost,stock,reorder_level,expiry_date}` |
| PUT | /api/products/:id | update a product |
| DELETE | /api/products/:id | delete a product |
| POST | /api/products/:id/restock | `{qty}` |
| POST | /api/sales | `{product_id,qty}` |
| GET | /api/dashboard | totals, alerts and weekly chart data |

## Before you put it on the internet

- Host it somewhere that keeps files between restarts (a VPS, or Render/Railway with a persistent disk), and put it behind HTTPS.
- Add login rate-limiting and password reset (not included yet).
- Set the `PORT` environment variable if your host requires it.
