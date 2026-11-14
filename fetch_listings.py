import csv, sys, time
import requests

BASE = "https://api-marketplace.theprosperty.com/v1/listings/search"
FILTER = ("category:=residential&&commercialization:=sale&&coordinates:"
          "(40.46079,27.38349,40.46079,18.44062,34.12232,18.44062,34.12232,27.38349)")

# usage: python fetch_listings.py [max_pages]   (default 2 for a quick test; 0 = all)
max_pages = int(sys.argv[1]) if len(sys.argv) > 1 else 2

def label(v):
    if isinstance(v, list):
        for x in v:
            if isinstance(x, dict) and x.get("locale") == "en":
                return x.get("value")
    return v

rows, page = [], 1
while True:
    r = requests.get(BASE, params={"filter_by": FILTER, "page": page,
                     "sort_by": "weight:desc", "per_page": 30},
                     headers={"Accept": "application/json"}, timeout=30)
    r.raise_for_status()
    j = r.json()
    for l in j["data"]["listings"]:
        lat, lng = (l.get("coordinates") or [None, None])[:2]
        rows.append({"id": l.get("id"), "lat": lat, "lng": lng,
                     "bedrooms": l.get("bedrooms"), "bathrooms": l.get("bathrooms"),
                     "build_year": l.get("build_year"), "floor": label(l.get("floor_label")),
                     "energy_class": ",".join(l.get("energy_class") or []),
                     "amenities": ",".join(l.get("amenities") or []),
                     "status": label((l.get("availability_status") or {}).get("label")),
                     "created_at": l.get("created_at")})
    m = j["meta"]
    print(f"page {m['current_page']}/{m['last_page']} total={m['total']} got={len(rows)}")
    if page >= m["last_page"] or (max_pages and page >= max_pages):
        break
    page += 1
    time.sleep(1)

with open("listings.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=rows[0].keys())
    w.writeheader(); w.writerows(rows)
print("saved", len(rows), "rows to listings.csv")
