# Shell TDS Extractor — User Guide

**Audience:** Technical staff in Estonia, Latvia, Lithuania  
**Purpose:** Extract product specifications from Shell Technical Data Sheets and prepare data for PIM import

---

## What This Tool Does

The Shell TDS Extractor reads PDF Technical Data Sheets and automatically extracts:
- Product name and short description
- Viscosity grade (e.g. 10W-30)
- API and ACEA specifications
- SAPS classification (Low-SAPS / Mid-SAPS)
- Fuel compatibility
- OEM approvals
- SKU codes for EE, LV and LT markets (looked up from product XML catalogues)

Extracted data is stored in a database and will be pushed to **pim.jungent.eu** for review before publishing to the Magento stores:

| Market | Store |
|--------|-------|
| Estonia | pood.jungent.eu |
| Latvia | shop.jungent.eu |
| Lithuania | store.jungent.eu |

---

## How to Upload

1. Open **tds.jungent.eu**
2. Drag one or more Shell TDS PDF files into the upload area, or click to browse
3. Click **Submit**
4. Wait up to 90 seconds — extracted data cards appear automatically when processing is complete
5. Review the results in the **Results** table below

---

## Reading the Results

| Column | Description |
|--------|-------------|
| Product name | Full Shell product name |
| Short description | One-line product description from the PDF |
| Viscosity | SAE viscosity grade |
| ACEA | European engine oil standards |
| API | American Petroleum Institute ratings |
| SAPS | Low-SAPS or Mid-SAPS (blank if standard) |
| Fuel | Diesel / Gasoline / CNG/LNG etc. |
| OEM | OEM approvals listed in the PDF |
| SKU EE / LV / LT | Article codes per market |

---

## Tips

- Upload multiple PDFs at once — they are processed sequentially
- Use the **Search** field to filter by product name
- Click **Refresh** to reload the table manually
- If a field shows **—**, the information was not found in the PDF or the SKU catalogue
- The interface is available in ET, LV, LT and EN — switch with the buttons in the top right corner

---

## Troubleshooting

**No results after 90 seconds**  
→ Check that the PDF is a genuine Shell Technical Data Sheet (not a Safety Data Sheet)  
→ Try uploading one file at a time  
→ Contact the system administrator

**SKU fields are empty**  
→ The product name in the PDF may differ from the XML catalogue entry  
→ Report the product name to the administrator so the catalogue can be updated

**Upload fails immediately**  
→ File must be a PDF under 20 MB  
→ Check your internet connection

---

## Data Flow

```
Shell TDS PDF
      ↓
tds.jungent.eu (upload)
      ↓
n8n (extraction + SKU lookup)
      ↓
pim.jungent.eu (review & publish)
      ↓
  ┌───────────────────────────┐
  │  pood.jungent.eu  (EE)   │
  │  shop.jungent.eu  (LV)   │
  │  store.jungent.eu (LT)   │
  └───────────────────────────┘
```
