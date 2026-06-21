"""
open_dashboard_allvbadmin_win.py
================================
Membuka browser Shopee Partner Portal untuk akun allvbadmin
menggunakan Chrome profile Windows (chrome_profile_win) di Linux.

Script ini akan meminta input Username & Password dari terminal,
memasukkannya secara otomatis ke halaman login, lalu mendeteksi
jika ada OTP (jika ada OTP, Anda dapat menyelesaikannya secara manual
di browser) dan menyimpan session secara otomatis ke session.json.

Usage (dari folder task-weekly/):
    uv run --project src weekly/open_dashboard_allvbadmin_win.py
"""

import os
import sys
import time
import json
from pathlib import Path
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options

# ── Path Setup ─────────────────────────────────────────────────────────────────
SCRIPT_DIR   = Path(__file__).resolve().parent          # weekly/
PROJECT_ROOT = SCRIPT_DIR.parent                        # weekly/
sys.path.insert(0, str(SCRIPT_DIR))

# Patch Options.add_argument agar otomatis menggunakan profile _win di Linux
orig_add_argument = Options.add_argument
def custom_add_argument(self, argument):
    if "--user-data-dir=" in argument:
        if argument.endswith("chrome_profile"):
            argument = argument + "_win"
        elif "chrome_profile_" in argument and not argument.endswith("_win"):
            argument = argument + "_win"
        print(f"🔧 [PATCH] Mengalihkan user data dir ke: {argument}")
    orig_add_argument(self, argument)

Options.add_argument = custom_add_argument

# ── Config ─────────────────────────────────────────────────────────────────────
ACCOUNT_NAME = "allvbadmin"
HEADLESS     = False   # Tampilkan browser GUI
DASHBOARD_URL = "https://partner.shopee.co.id/food/dashboard"

DATA_DIR     = SCRIPT_DIR / "data"
SESSION_FILE = DATA_DIR / "session.json"


def main():
    from core import browser

    # Load default credentials dari credentials.json
    default_user = ""
    default_pass = ""
    creds_file = SCRIPT_DIR / "credentials.json"
    if creds_file.exists():
        try:
            creds = json.loads(creds_file.read_text())
            default_user = creds.get("shopee_username", "")
            default_pass = creds.get("shopee_password", "")
        except:
            pass

    print("🔑 SILAKAN INPUT KREDENSIAL SHOPEE PARTNER")
    username = input(f"Masukkan Username [{default_user}]: ").strip() or default_user
    password = input(f"Masukkan Password [{'*****' if default_pass else ''}]: ").strip() or default_pass
    print()

    print(f"🚀 Membuka dashboard Shopee untuk akun: {ACCOUNT_NAME}")
    print(f"   Session file : {SESSION_FILE}")
    print(f"   Target Profile: {DATA_DIR / 'chrome_profile_win'}")
    print()

    # Arahkan browser module ke session file akun ini
    browser.set_session_file(SESSION_FILE)

    print("🌐 Memulai browser (menggunakan chrome_profile_win)...")
    driver = browser._init_driver(headless=HEADLESS)
    wait = WebDriverWait(driver, 20)
    
    try:
        # Navigate to dashboard
        print("🔗 Menghubungkan ke Shopee Partner Portal...")
        driver.get(DASHBOARD_URL)
        time.sleep(3)
        
        is_logged_in = False
        current_url = driver.current_url.lower()
        
        # Check if already logged in via profile cookies
        if "dashboard" in current_url or "merchant-selector" in current_url or "onboarding" in current_url:
            print("✅ Sesi aktif terdeteksi langsung dari profile.")
            is_logged_in = True
        else:
            # Try to restore using plaintext session.json if it exists
            if SESSION_FILE.exists():
                print("🔍 Mencoba memulihkan sesi menggunakan session.json...")
                try:
                    saved = json.loads(SESSION_FILE.read_text())
                    driver.add_cookie({"name": "shopee_tob_token", "value": saved["shopee_tob_token"]})
                    if saved.get("shopee_tob_entity_id"):
                        driver.add_cookie({"name": "shopee_tob_entity_id", "value": saved["shopee_tob_entity_id"]})
                    for n, v in saved.get("extra_cookies", {}).items():
                        try:
                            driver.add_cookie({"name": n, "value": v})
                        except:
                            pass
                    driver.refresh()
                    time.sleep(4)
                    current_url = driver.current_url.lower()
                    if "dashboard" in current_url or "merchant-selector" in current_url or "onboarding" in current_url:
                        print("✅ Sesi berhasil dipulihkan dari session.json!")
                        is_logged_in = True
                except Exception as e:
                    print(f"⚠️ Gagal memulihkan dari session.json: {e}")

        # If not logged in, execute automation to type credentials
        if not is_logged_in:
            print("⚠️ Sesi tidak aktif. Mengalihkan ke login page untuk pengisian kredensial otomatis...")
            if "login" not in driver.current_url.lower() and "authenticate" not in driver.current_url.lower():
                driver.get("https://partner.shopee.co.id/login")
                time.sleep(4)

            # Auto fill username & password
            try:
                user_input = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "input[name='userName'], input[type='text']")))
                user_input.send_keys(Keys.CONTROL + "a", Keys.BACKSPACE)
                user_input.send_keys(username)
                
                pass_input = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "input[type='password']")))
                pass_input.send_keys(Keys.CONTROL + "a", Keys.BACKSPACE)
                pass_input.send_keys(password)
                
                print("✍️ Mengisi Username dan Password...")
                time.sleep(1)
                
                # Klik Masuk
                login_btn = driver.find_element(By.XPATH, "//button[contains(., 'Masuk') or contains(., 'Log In')] | //button[@type='submit']")
                login_btn.click()
                print("👉 Mengklik tombol Masuk...")
            except Exception as e:
                print(f"❌ Gagal mengisi form login secara otomatis: {e}")
                print("👉 Silakan isi manual langsung di browser.")

            # Monitor post-login redirect & OTP
            print("⏳ Memantau status login setelah submit...")
            while True:
                time.sleep(2)
                try:
                    curr_url = driver.current_url.lower()
                    
                    # 1. Cek jika berhasil masuk dashboard / merchant-selector
                    if "dashboard" in curr_url or "merchant-selector" in curr_url or "onboarding" in curr_url:
                        print("\n🎉 Login sukses!")
                        time.sleep(3)
                        
                        # Simpan session ke session.json
                        tob_token, entity_id = browser.extract_tokens_from_driver(driver)
                        if tob_token:
                            extra = browser.get_all_cookies_dict(driver)
                            browser.save_session(tob_token, entity_id or "", extra)
                            print(f"💾 Sesi baru disimpan ke: {SESSION_FILE}")
                        break
                        
                    # 2. Deteksi halaman verifikasi / OTP
                    otp_present = driver.execute_script("""
                        var texts = ["verifikasi", "otp", "kode", "verify", "enter code"];
                        var body = (document.body.innerText || "").toLowerCase();
                        var has_otp_input = !!document.querySelector("input[maxlength='6'], .shopee-otp-input");
                        return has_otp_input || texts.some(function(t) { return body.includes(t); });
                    """)
                    if otp_present:
                        print("⚠️ OTP / Verifikasi terdeteksi! Silakan selesaikan proses verifikasi di browser secara manual...")
                        # Tunggu user menyelesaikan OTP
                        while True:
                            time.sleep(2)
                            curr_url = driver.current_url.lower()
                            if "dashboard" in curr_url or "merchant-selector" in curr_url or "onboarding" in curr_url:
                                print("\n🎉 Login sukses setelah OTP!")
                                time.sleep(3)
                                tob_token, entity_id = browser.extract_tokens_from_driver(driver)
                                if tob_token:
                                    extra = browser.get_all_cookies_dict(driver)
                                    browser.save_session(tob_token, entity_id or "", extra)
                                    print(f"💾 Sesi baru disimpan ke: {SESSION_FILE}")
                                break
                        break
                except Exception:
                    print("\n🔴 Jendela browser ditutup sebelum login selesai.")
                    sys.exit(0)

        # Handle merchant selection if needed
        current_url = driver.current_url.lower()
        if "merchant-selector" in current_url or "onboarding" in current_url:
            print("📍 Berada di halaman pemilihan merchant. Silakan pilih outlet secara manual di browser.")

        print()
        print("=" * 55)
        print("  Browser aktif menggunakan profile Windows.")
        print("  Tekan Ctrl+C di terminal ini untuk menutup.")
        print("=" * 55)

        # Keep browser open
        while True:
            time.sleep(2)
            try:
                # Check if browser is still open
                _ = driver.current_url
            except Exception:
                print("\n🔴 Jendela browser ditutup.")
                break

    except KeyboardInterrupt:
        print("\n🛑 Dihentikan oleh pengguna.")
    finally:
        try:
            driver.quit()
        except Exception:
            pass
        print("✅ Selesai.")


if __name__ == "__main__":
    main()
