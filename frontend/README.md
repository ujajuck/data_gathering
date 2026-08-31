# KG Source Viewer

React + TypeScript + Vite frontend for read-only KG evidence review. The initial
engine uses LibreOffice-generated PDF previews rendered by PDF.js. KG components
depend only on `WorkbookViewerAdapter`, so another engine can replace PDF.js
without changing source locators or KG state.

```bash
npm install
npm run dev
```

Open a logical source (no filesystem path is accepted by the frontend):

```text
/?documentId=DOC&version=VER&sheet=190%EB%8F%84&range=G7:G20&concept=weight
```

The backend must run on port 8010 in development. A preview is available only
after an authorized unlock result has passed XLSX validation and LibreOffice
rendering has completed.

## Engine boundary

`src/viewer/ViewerAdapter.ts` is the stable contract. `LibreOfficePdfViewerAdapter`
owns engine-specific state, while Domain KG, Document KG, Parsing Template and
integration data remain logical identifiers plus Sheet/A1 ranges.

## License notes

Runtime dependencies are pinned for reproducible review. React is MIT licensed;
PDF.js is Apache-2.0 licensed; Vite is MIT licensed. LibreOffice is an external
rendering process and is not bundled by this package. Deployment owners should
regenerate and review third-party notices for the exact deployed dependency tree.
