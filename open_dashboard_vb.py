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
        
        pass_input = None
        for sel in ["input[type='password']", "input[placeholder='Password']"]:
            try:
                el = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, sel)))
                if el.is_displayed():
                    pass_input = el
                    break
            except:
                continue

        # Fill via React prototype setter to ensure framework state synchronization
        if user_input:
            driver.execute_script("""
                var el = arguments[0];
                var val = arguments[1];
                el.focus();
                var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                setter.call(el, val);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
            """, user_input, cred["username"])
            
        if pass_input:
            driver.execute_script("""
                var el = arguments[0];
                var val = arguments[1];
                el.focus();
                var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                setter.call(el, val);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
            """, pass_input, cred["password"])

        time.sleep(0.5)

        # Native click and keypress simulation fallback
        if user_input:
            try:
                user_input.click()
                time.sleep(0.2)
                user_input.send_keys(Keys.END)
                user_input.send_keys(Keys.BACKSPACE)
                user_input.send_keys(cred["username"][-1])
                time.sleep(0.2)
            except:
                pass

        if pass_input:
            try:
                pass_input.click()
                time.sleep(0.2)
                pass_input.send_keys(Keys.END)
                pass_input.send_keys(Keys.BACKSPACE)
                pass_input.send_keys(cred["password"][-1])
                time.sleep(0.2)
            except:
                pass

        # Trigger blur on both to finalize validation
        try:
            driver.execute_script("""
                if (arguments[0]) arguments[0].blur();
                if (arguments[1]) arguments[1].blur();
            """, user_input, pass_input)
        except:
            pass
        time.sleep(0.5)

        # CRITICAL: React validation requires actual user interaction events
        # Click and focus the fields sequentially to activate the disabled login button.
        try:
            for field in [user_input, pass_input, user_input]:
                if field:
                    driver.execute_script("""
                        var el = arguments[0];
                        el.focus();
                        el.click();
                        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                        el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    """, field)
                    time.sleep(0.2)
        except Exception as e:
            log.warning(f"⚠️ Failed to dispatch interaction events for '{name}': {e}")

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
            try:
                driver.execute_script("""
                    var btn = arguments[0];
                    if (btn.hasAttribute('disabled')) {
                        btn.removeAttribute('disabled');
                        btn.classList.remove('ant-btn-loading', 'disabled');
                    }
                """, login_btn)
                time.sleep(0.2)
                login_btn.click()
            except:
                driver.execute_script("arguments[0].click();", login_btn)
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

def handle_post_login_flow(driver, name, target_merchant):
    log.info(f"⏳ Memantau status login dan redirect untuk VB '{name}'...")
    wait = WebDriverWait(driver, 15)
    start_time = time.time()
    
    # Wait up to 60 seconds for login redirect / flow completion
    while time.time() - start_time < 60:
        try:
            curr_url = driver.current_url.lower()
            
            # If we successfully land on dashboard, let's check the merchant
            if "/food/dashboard" in curr_url:
                log.info(f"✅ VB '{name}' berhasil masuk dashboard.")
                break
                
            # If we land on onboarding or merchant-selector
            if "onboarding" in curr_url or "merchant-selector" in curr_url:
                log.info(f"📍 VB '{name}' mendeteksi halaman selector/onboarding. Memilih merchant pertama...")
                time.sleep(2)
                
                # Check for "Gabung" invitation button first
                try:
                    btn_xpath = "//button[contains(., 'Gabung dengan Merchant') or contains(., 'Gabung') or contains(text(), 'Gabung')]"
                    btns = driver.find_elements(By.XPATH, btn_xpath)
                    clicked_inv = False
                    for btn in btns:
                        if btn.is_displayed():
                            btn.click()
                            log.info(f"👉 Mengklik tombol 'Gabung' untuk VB '{name}'")
                            time.sleep(5)
                            clicked_inv = True
                            break
                    if clicked_inv:
                        continue
                except Exception as e:
                    log.debug(f"Error checking Gabung button: {e}")
                
                # Select first merchant in list
                bypass_js = """
                    var loaders = document.querySelectorAll('.ant-spin, [class*="loading"], .shopee-loading, .ant-spin-nested-loading');
                    loaders.forEach(el => el.remove());
                    var target = document.querySelector('.listItem, .merchant-item, li[class*="item"], [class*="merchant-item"], .ant-list-item');
                    if (target) {
                        target.scrollIntoView({block: 'center'});
                        try { target.click(); } catch(e) {}
                        var clickEvent = new MouseEvent('click', {
                            bubbles: true,
                            cancelable: true,
                            view: window
                        });
                        target.dispatchEvent(clickEvent);
                        return true;
                    }
                    return false;
                """
                try:
                    if driver.execute_script(bypass_js):
                        log.info(f"✅ VB '{name}' berhasil memicu pemilihan merchant pertama.")
                        time.sleep(5)
                except Exception as e:
                    log.warning(f"⚠️ Gagal klik merchant pertama untuk VB '{name}': {e}")
                
            # Click "Lanjutkan" or "Continue" if visible
            try:
                btn_el = driver.find_element(By.XPATH, "//button[contains(., 'Lanjutkan') or contains(., 'Continue')] | //*[text()='Lanjutkan' or text()='Continue']")
                if btn_el.is_displayed():
                    log.info(f"👉 VB '{name}' menemukan tombol 'Lanjutkan', mengklik...")
                    try:
                        btn_el.click()
                    except:
                        driver.execute_script("arguments[0].click();", btn_el)
                    time.sleep(2)
            except:
                pass
                
            # Check for OTP input page, if so warn user
            otp_present = False
            try:
                otp_present = driver.execute_script("""
                    var has_otp = !!document.querySelector("input[maxlength='6'], .shopee-otp-input, input.shopee-otp-input__input");
                    var body = (document.body.innerText || "").toLowerCase();
                    return has_otp || body.includes("otp") || body.includes("verifikasi") || body.includes("verification code");
                """)
            except:
                pass
                
            if otp_present:
                # Log only periodically to avoid spamming
                log.info(f"🔑 VB '{name}' memerlukan OTP/Verifikasi. Silakan masukkan OTP secara manual di browser...")
                time.sleep(5)
                
            time.sleep(1)
        except Exception as e:
            # If browser is closed or other fatal error
            break

def launch_portal_browser(name):
    log.info(f"🌐 Membuka browser untuk VB '{name}'...")
    try:
        driver = _init_driver(headless=False, account_name=name)
        drivers[name] = driver
        
        # Navigate to shopee partner home
        driver.get("https://partner.shopee.co.id/")
        time.sleep(2)
        
        # Load saved session cookies if they exist and are valid
        saved = load_session(name)
        is_valid = False
        if saved:
            try:
                from core.browser import validate_session
                is_valid = validate_session(saved["shopee_tob_token"], saved["shopee_tob_entity_id"])
            except Exception as val_err:
                log.warning(f"⚠️ Gagal memvalidasi sesi untuk '{name}': {val_err}")
                is_valid = False

        if saved and is_valid:
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
            log.warning(f"⚠️ Sesi tidak ditemukan atau kedaluwarsa untuk VB '{name}'. Silakan login/autofill manual.")
            driver.get("https://partner.shopee.co.id/login")
            time.sleep(4)

        # Get credentials details
        cred = get_credentials(name)
        target_merchant = cred.get("merchant_name") if cred else None

        # Wait dynamically for either login page or dashboard to be loaded with merchant info
        log.info(f"⏳ Menunggu halaman termuat untuk VB '{name}'...")
        is_logged_in = False
        active_name = ""
        
        for _ in range(30):  # 15 seconds max wait
            curr_url = driver.current_url.lower()
            if "login" in curr_url or "authenticate" in curr_url:
                break
            try:
                el = driver.find_element(By.CSS_SELECTOR, ".merchantName")
                if el.is_displayed():
                    active_name = el.text.strip()
                    if active_name:
                        is_logged_in = True
                        break
            except:
                pass
            time.sleep(0.5)

        # Check login or wrong/admin state
        current_url = driver.current_url.lower()
        if "login" in current_url or "authenticate" in current_url or not is_logged_in:
            if cred:
                if "login" not in current_url and "authenticate" not in current_url:
                    driver.get("https://partner.shopee.co.id/login")
                    time.sleep(4)
                autofill_login_form(driver, cred, name)
                # Wait for post login, click lanjutkan, bypass onboarding/selector
                handle_post_login_flow(driver, name, target_merchant)
        else:
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
                            recovered = _deliberate_logout_and_relogin(
                                driver,
                                username=cred.get("username"),
                                password=cred.get("password"),
                                phone=cred.get("phone")
                            )
                            if recovered:
                                # Wait for post login, click lanjutkan, bypass onboarding/selector
                                handle_post_login_flow(driver, name, target_merchant)
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
    print("1. portal_f (F)")
    print("2. portal_w (W)")
    print("3. portal_l (L)")
    print("4. portal_d (D)")
    print("5. Semua Portal (f, w, l, d)")
    print("="*60)
    
    try:
        choice = input("Pilih portal yang ingin dibuka (1-5, default 5): ").strip()
    except (KeyboardInterrupt, EOFError):
        print("\nExiting.")
        return

    selected_portals = []
    if choice == "1":
        selected_portals = ["portal_f"]
    elif choice == "2":
        selected_portals = ["portal_w"]
    elif choice == "3":
        selected_portals = ["portal_l"]
    elif choice == "4":
        selected_portals = ["portal_d"]
    elif choice == "5" or not choice:
        selected_portals = portals
    else:
        print("ℹ️ Pilihan tidak valid, membuka semua portal secara default...")
        selected_portals = portals

    threads = []
    for p in selected_portals:
        t = threading.Thread(target=launch_portal_browser, args=(p,), daemon=True)
        threads.append(t)
        t.start()
        time.sleep(5.0) # stagger launch to avoid high CPU load and port collision

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
