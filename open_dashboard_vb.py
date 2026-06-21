import os
import sys
import time
import threading
import json
from pathlib import Path
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

# Add VB directory to path so core/ imports work
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), 'VB')))

from core.browser import _init_driver, load_session
from core.logger import get_logger

log = get_logger("open_dashboards_vb")

portals = ["portal_f", "portal_w", "portal_l", "portal_d"]
drivers = {}

def get_credentials(account_name):
    try:
        cred_path = Path(__file__).resolve().parent / "VB" / "shopee" / "credentials_vb.json"
        if cred_path.exists():
            with open(cred_path, "r") as f:
                data = json.load(f)
                for portal in data.get("portals", []):
                    if portal.get("account_name") == account_name:
                        return portal
    except Exception as e:
        log.warning(f"⚠️ Gagal membaca credentials_vb.json: {e}")
    return None

def autofill_login_form(driver, cred, name):
    log.info(f"✍️ Mengisi otomatis username & password untuk VB '{name}'...")
    try:
        from selenium.webdriver.common.keys import Keys
        wait = WebDriverWait(driver, 10)
        user_input = None
        for sel in ["input[name='userName']", "input[placeholder*='handphone']", "input[placeholder*='Username']"]:
            try:
                el = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, sel)))
                if el.is_displayed():
                    user_input = el
                    break
            except:
                continue
        
        if user_input:
            user_input.send_keys(Keys.CONTROL + "a", Keys.BACKSPACE)
            user_input.send_keys(cred["username"])
            
        pass_input = None
        for sel in ["input[type='password']", "input[placeholder='Password']"]:
            try:
                el = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, sel)))
                if el.is_displayed():
                    pass_input = el
                    break
            except:
                continue
                
        if pass_input:
            pass_input.send_keys(Keys.CONTROL + "a", Keys.BACKSPACE)
            pass_input.send_keys(cred["password"])
            
        # Click login button
        login_btn = None
        for btn_sel in ["//button[contains(., 'Masuk') or contains(., 'Log In')]", "//button[@type='submit']"]:
            try:
                btn = wait.until(EC.element_to_be_clickable((By.XPATH, btn_sel)))
                if btn.is_displayed():
                    login_btn = btn
                    break
            except:
                continue
                
        if login_btn:
            log.info(f"👉 Mengeklik tombol login untuk VB '{name}'...")
            login_btn.click()
    except Exception as autofill_err:
        log.warning(f"⚠️ Gagal mengisi otomatis credentials/login untuk '{name}': {autofill_err}")

def save_current_session(driver, name):
    try:
        from core.browser import _trigger_and_extract_tokens, get_all_cookies_dict, save_session, set_session_file, get_session_file_path
        log.info(f"💾 Menyimpan sesi baru untuk VB '{name}'...")
        # Ensure the background thread has its thread-local session file configured correctly
        set_session_file(get_session_file_path(name))
        
        t, eid = _trigger_and_extract_tokens(driver)
        if t:
            all_c = get_all_cookies_dict(driver)
            save_session(t, eid or "", extra_cookies=all_c)
            log.info(f"✅ Sesi baru untuk VB '{name}' berhasil disimpan.")
        else:
            log.warning(f"⚠️ Gagal mengekstrak token untuk VB '{name}'. Sesi tidak disimpan.")
    except Exception as e:
        log.warning(f"⚠️ Gagal menyimpan sesi VB '{name}': {e}")

def monitor_and_save_session(driver, name, target_merchant):
    log.info(f"👀 Memulai monitoring sesi untuk VB '{name}' (Target Outlet: '{target_merchant}')...")
    last_saved_url = ""
    while True:
        try:
            # If browser is closed, this call will raise an exception and break the loop
            current_url = driver.current_url.lower()
            
            if "/food/dashboard" in current_url:
                try:
                    active_name = driver.find_element(By.CSS_SELECTOR, ".merchantName").text.strip()
                except:
                    active_name = ""
                
                is_admin = "admin" in active_name.lower() or active_name.lower() == "unknown merchant"
                is_correct = target_merchant and target_merchant.lower() in active_name.lower()
                
                if active_name and not is_admin and is_correct:
                    state_key = f"{current_url}_{active_name}"
                    if state_key != last_saved_url:
                        log.info(f"✨ Sesi aktif terdeteksi untuk VB '{name}' ({active_name}). Menyimpan/memperbarui sesi...")
                        save_current_session(driver, name)
                        last_saved_url = state_key
            
            time.sleep(3)
        except Exception:
            # Browser was closed
            break

def launch_portal_browser(name):
    log.info(f"🌐 Membuka browser untuk VB '{name}'...")
    try:
        driver = _init_driver(headless=False, account_name=name)
        drivers[name] = driver
        
        # Navigate to shopee partner home
        driver.get("https://partner.shopee.co.id/")
        time.sleep(2)
        
        # Load saved session cookies if they exist
        saved = load_session(name)
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
            time.sleep(4)
        else:
            log.warning(f"⚠️ Sesi tidak ditemukan untuk VB '{name}'. Silakan login manual.")
            driver.get("https://partner.shopee.co.id/login")
            time.sleep(4)

        # Get credentials details
        cred = get_credentials(name)
        target_merchant = cred.get("merchant_name") if cred else None

        # Check login or wrong/admin state
        current_url = driver.current_url.lower()
        if "login" in current_url or "authenticate" in current_url:
            if cred:
                autofill_login_form(driver, cred, name)
        else:
            # Try to check active merchant name
            try:
                active_name = driver.find_element(By.CSS_SELECTOR, ".merchantName").text.strip()
            except:
                active_name = ""
                
            is_admin = "admin" in active_name.lower() or active_name.lower() == "unknown merchant"
            is_wrong_merchant = target_merchant and target_merchant.lower() not in active_name.lower()
            
            if is_admin or is_wrong_merchant:
                log.warning(f"⚠️ Terdeteksi merchant aktif tidak sesuai untuk VB '{name}': '{active_name}' (Target: '{target_merchant}').")
                success = False
                
                # Switch if it is just a wrong merchant (not admin/unknown)
                if is_wrong_merchant and not is_admin:
                    log.info(f"🔄 Mencoba beralih ke merchant '{target_merchant}'...")
                    try:
                        from core.browser import auto_switch_merchant
                        success = auto_switch_merchant(driver, target_merchant)
                    except Exception as switch_err:
                        log.warning(f"⚠️ Gagal switch merchant: {switch_err}")
                
                # Trigger logout and relogin if switch failed or if in Admin state
                if not success:
                    log.info(f"🔄 Memicu logout system untuk pemulihan VB '{name}'...")
                    try:
                        from core.browser import _deliberate_logout_and_relogin
                        if cred:
                            _deliberate_logout_and_relogin(
                                driver,
                                username=cred.get("username"),
                                password=cred.get("password"),
                                phone=cred.get("phone")
                            )
                    except Exception as logout_err:
                        log.error(f"❌ Gagal memicu logout/relogin: {logout_err}")

        # Start background monitoring thread to automatically save session when successfully logged into the target merchant
        if target_merchant:
            monitor_thread = threading.Thread(target=monitor_and_save_session, args=(driver, name, target_merchant), daemon=True)
            monitor_thread.start()

    except Exception as e:
        log.error(f"❌ Gagal membuka browser untuk VB '{name}': {e}")

def main():
    print("\n" + "="*60)
    print("📋 PILIHAN PORTAL VB SHOPEE:")
    print("1. Semua Portal (f, w, l, d)")
    print("2. portal_f (F)")
    print("3. portal_w (W)")
    print("4. portal_l (L)")
    print("5. portal_d (D)")
    print("="*60)
    
    try:
        choice = input("Pilih portal yang ingin dibuka (1-5, default 1): ").strip()
    except (KeyboardInterrupt, EOFError):
        print("\nExiting.")
        return

    selected_portals = []
    if choice == "1" or not choice:
        selected_portals = portals
    elif choice == "2":
        selected_portals = ["portal_f"]
    elif choice == "3":
        selected_portals = ["portal_w"]
    elif choice == "4":
        selected_portals = ["portal_l"]
    elif choice == "5":
        selected_portals = ["portal_d"]
    else:
        print("ℹ️ Pilihan tidak valid, membuka semua portal secara default...")
        selected_portals = portals

    threads = []
    for p in selected_portals:
        t = threading.Thread(target=launch_portal_browser, args=(p,), daemon=True)
        threads.append(t)
        t.start()
        time.sleep(1.5) # stagger launch slightly to avoid high CPU load

    print("\n" + "="*60)
    print(f"🚀 Browser untuk {len(selected_portals)} portal VB Shopee telah dibuka!")
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
