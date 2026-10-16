# Script Query Dashboard

Web-only app for loading the attached JavaScript, pasting the JSON it produces, classifying each query by date/time, visualizing the metrics, and exporting the visible rows to `.xls`.

## Usage

1. Install dependencies:
   ```powershell
   cmd /c npm install
   ```
2. Start the app:
   ```powershell
   cmd /c npm run dev
   ```
3. Open `http://localhost:5173`.
4. Paste the script output or load a file, then click **Run script** to classify it in the browser.
5. Use the filters, charts, and **Export visible rows (.xls)** button to work with the current view.

## Notes

- The attached JavaScript is preserved at `assets\scripts\default-rnpdno-dashboard-cdmx.js`.
- This version does not depend on Node/DevTools to execute the source query; it operates fully in the browser.
- Local run history is stored in `localStorage`.

## Validation

```powershell
cmd /c npm run build
```
