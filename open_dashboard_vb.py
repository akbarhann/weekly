import os
import sys
import time
import threading
from pathlib import Path

# Add VB directory to path so core/ imports work
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), 'VB')))

from core.browser import _init_driver, load_session
from core.logger import get_logger

log = get_logger("open_dashboards_vb")

portals = ["portal_f", "portal_w", "portal_l", "portal_d"]
drivers = {}

def launch_portal_browser(name):
    log.info(f"🌐 Membuka browser untuk VB '{name}'...")
    try:
        driver = _init_driver(headless=False, account_name=name)
        drivers[name] = driver
        
        # Navigate to shopee partner home
        driver.get("https://partner.shopee.co.id/")
        time.sleep(2)
        
        # Load saved session cookies if they exist
        saved = load_session()
        if saved:
            log.info(f"🔑 Memasukkan cookie sesi tersimpan untuk VB '{name}'...")
            try:
                driver.add_cookie({"name": "shopee_tob_token", "value": saved["shopee_tob_token"]})
                if saved.get("shopee_tob_entity_id"):
                    driver.add_cookie({"name": "shopee_tob_entity_id", "value": saved["shopee_tob_entity_id"]})
                for n, v in saved.get("extra_cookies", {}).items():
                    try:
                        driver.add_cookie({"name": n, "value": v})
                    except:
                        pass
            except Exception as cookie_err:
                log.warning(f"⚠️ Gagal menambahkan sebagian cookie untuk '{name}': {cookie_err}")
            
            # Refresh to apply cookies and go to dashboard
            driver.get("https://partner.shopee.co.id/food/dashboard")
        else:
            log.warning(f"⚠️ Sesi tidak ditemukan untuk VB '{name}'. Silakan login manual.")
            driver.get("https://partner.shopee.co.id/login")

    except Exception as e:
        log.error(f"❌ Gagal membuka browser untuk VB '{name}': {e}")

def main():
    threads = []
    for p in portals:
        t = threading.Thread(target=launch_portal_browser, args=(p,), daemon=True)
        threads.append(t)
        t.start()
        time.sleep(1.5) # stagger launch slightly to avoid high CPU load

    print("\n" + "="*60)
    print("🚀 Browser untuk keempat portal VB Shopee telah dibuka!")
    print("Anda dapat berinteraksi langsung dengan browser tersebut.")
    print("Tekan ENTER di terminal ini atau Ctrl+C untuk menutup semua browser secara bersamaan.")
    print("="*60 + "\n")
    
    try:
        input()
    except KeyboardInterrupt:
        pass
    
    print("🧹 Menutup semua browser...")
    for name, driver in list(drivers.items()):
        try:
            driver.quit()
            print(f"✅ Browser VB '{name}' ditutup.")
        except:
            pass

if __name__ == "__main__":
    main()
