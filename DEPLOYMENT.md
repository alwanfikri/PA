# 🚀 Lumina PWA — Deployment Guide

---

## PART 1 — Google Apps Script Setup

### Step 1: Create a Google Spreadsheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet
2. Copy the Spreadsheet ID from the URL:
   ```
   https://docs.google.com/spreadsheets/d/[SPREADSHEET_ID]/edit
   ```

### Step 2: Create a Google Drive Folder

1. Go to [drive.google.com](https://drive.google.com)
2. Create a new folder named **"Lumina Photos"**
3. Copy the folder ID from the URL:
   ```
   https://drive.google.com/drive/folders/[FOLDER_ID]
   ```

### Step 3: Create the Apps Script Project

1. Go to [script.google.com](https://script.google.com)
2. Click **"New Project"**
3. Rename it to **"Lumina Backend"**

### Step 4: Add the Script Files

Create 4 files in the Apps Script editor:

| File | Content from |
|------|-------------|
| `Code.gs` | `/gas/Code.gs` |
| `SheetAPI.gs` | `/gas/SheetAPI.gs` |
| `CalendarAPI.gs` | `/gas/CalendarAPI.gs` |
| `DriveAPI.gs` | `/gas/DriveAPI.gs` |

> To add a new file: Click the **+** button in the Files panel → Script

### Step 5: Configure IDs

In `Code.gs`, update the CONFIG object:

```javascript
var CONFIG = {
  SPREADSHEET_ID: 'paste-your-spreadsheet-id-here',
  DRIVE_FOLDER_ID: 'paste-your-drive-folder-id-here',
  CALENDAR_ID: 'primary',  // or your calendar ID
  ALLOWED_ORIGINS: '*'     // or 'https://yourname.github.io'
};
```

### Step 6: Deploy as Web App

1. Click **"Deploy"** → **"New Deployment"**
2. Click the gear icon ⚙ → Select type: **"Web App"**
3. Configure:
   - **Description**: Lumina API v1.0
   - **Execute as**: **Me** (your Google account)
   - **Who has access**: **Anyone**
4. Click **"Deploy"**
5. **Authorize** the required permissions (Google Sheets, Calendar, Drive)
6. Copy the Web App URL — it looks like:
   ```
   https://script.google.com/macros/s/AKfycb...xxxx/exec
   ```

### Step 7: Test the API

Open the URL in your browser — you should see:
```json
{"status":"ok","app":"Lumina API","version":"1.0.0"}
```

---

## PART 2 — Connect PWA to API

### In the Lumina App (Settings):

1. Open Lumina PWA in your browser
2. Tap the **⚙ Settings** button (top right)
3. Paste your Apps Script Web App URL into **"Google Apps Script API"**
4. Tap **"Save & Sync"**

The app will immediately sync any pending local changes to Google.

---

## PART 3 — Deploy PWA to GitHub Pages

### Option A: Quick Deploy (GitHub UI)

1. Create a new GitHub repository (e.g., `lumina-pwa`)
2. Upload all files from the `/pwa-app` folder to the repository root
3. Go to **Settings → Pages**
4. Set Source: **Deploy from branch** → `main` → `/ (root)`
5. Save — your app will be live at:
   ```
   https://yourusername.github.io/lumina-pwa/
   ```

### Option B: Git Command Line

```bash
# Initialize git in the pwa-app folder
cd pwa-app
git init
git add .
git commit -m "Initial Lumina PWA deployment"

# Create repo on GitHub, then push
git remote add origin https://github.com/yourusername/lumina-pwa.git
git branch -M main
git push -u origin main

# Enable GitHub Pages in repository Settings → Pages
```

### Option C: GitHub Actions (Auto-deploy)

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: '.'
      - uses: actions/deploy-pages@v4
```

---

## PART 4 — Icons (Production)

Replace the SVG icons in `/icons` with proper PNG icons.

### Using ImageMagick:
```bash
for size in 72 96 128 144 152 192 384 512; do
  convert -background none -resize ${size}x${size} icons/icon-512.svg icons/icon-${size}.png
done
```

### Using Node.js sharp:
```bash
npm install sharp
node -e "
const sharp = require('sharp');
const sizes = [72,96,128,144,152,192,384,512];
sizes.forEach(s => sharp('icons/icon-512.svg').resize(s,s).png().toFile('icons/icon-'+s+'.png'));
"
```

Then update `manifest.json` to use `.png` extensions instead of `.svg`.

---

## PART 5 — Install as PWA

### On Android (Chrome):
1. Open the app URL in Chrome
2. Tap the **three dots menu** → **"Add to Home Screen"**
3. Or wait for the install banner to appear

### On iOS (Safari):
1. Open the app URL in Safari
2. Tap the **Share button** → **"Add to Home Screen"**

### On Desktop (Chrome):
1. Look for the install icon in the address bar
2. Click it → **"Install"**

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| API not responding | Re-deploy Apps Script with a **New Deployment** |
| "Authorization required" | Run any function in Apps Script editor and grant permissions |
| Photos not uploading | Ensure Drive folder ID is correct in CONFIG |
| Calendar sync fails | Check that Calendar ID is correct (use 'primary' for default) |
| SW not registering | Must be served over HTTPS (GitHub Pages provides this) |
| Offline mode not working | Clear browser cache, hard reload |

---

## Security Notes

- The Apps Script runs as **your Google account** — treat the URL like a password
- Optionally set `ALLOWED_ORIGINS` to your specific GitHub Pages domain
- Never commit real IDs or credentials to public repositories
- For production, add authentication (Google Sign-In or similar)
