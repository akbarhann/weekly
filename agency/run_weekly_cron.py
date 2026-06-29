#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════
  AGENCY REPORT — Weekly Automated Cron Runner
  Calculates last week's date range (Mon-Sun) and runs cli.py
  Designed to be run via Linux crontab on Monday mornings.
═══════════════════════════════════════════════════════════════
"""

import os
import sys
import subprocess
import logging
from datetime import datetime, timedelta

# Set up paths
base_dir = os.path.dirname(os.path.abspath(__file__))
log_dir = os.path.join(base_dir, "logs")
os.makedirs(log_dir, exist_ok=True)

# Set up logging
log_file = os.path.join(log_dir, f"cron_run_{datetime.now().strftime('%Y-%m-%d')}.log")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(log_file),
        logging.StreamHandler(sys.stdout)
    ]
)

log = logging.getLogger("agency-cron")

def get_previous_week_range():
    # Target WIB (GMT+7)
    # Get current UTC time, then convert to WIB
    now_utc = datetime.utcnow()
    now_wib = now_utc + timedelta(hours=7)
    
    # Calculate days to last Sunday (weekday(): 0=Monday, 6=Sunday)
    # If today is Monday (0), last Sunday was 1 day ago.
    # If today is Tuesday (1), last Sunday was 2 days ago, etc.
    weekday = now_wib.weekday()
    days_to_last_sunday = weekday + 1
    
    last_sunday = now_wib - timedelta(days=days_to_last_sunday)
    last_monday = last_sunday - timedelta(days=6)
    
    return last_monday.strftime("%Y-%m-%d"), last_sunday.strftime("%Y-%m-%d")

def main():
    log.info("=" * 60)
    log.info("🚀 STARTING WEEKLY AGENCY AUTOMATED CRON JOB")
    log.info("=" * 60)
    
    start_date, end_date = get_previous_week_range()
    log.info(f"Calculated Period (Last Week): {start_date} to {end_date}")
    
    # Resolve python executable from virtual environment
    venv_py = os.path.join(base_dir, ".venv", "bin", "python")
    python_exe = venv_py if os.path.isfile(venv_py) else "python3"
    
    cli_path = os.path.join(base_dir, "cli.py")
    
    # Run the pipeline for all outlets, all platforms (platform = all)
    # We use --skip-existing to avoid re-downloading already processed merchants
    cmd = [
        python_exe, "-u", cli_path, "all",
        "--start", start_date,
        "--end", end_date,
        "--skip-existing"
    ]
    
    log.info(f"Executing command: {' '.join(cmd)}")
    
    # Set up process environment (preserving existing env)
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["TZ"] = "Asia/Jakarta"
    
    try:
        # Run process and pipe output to log
        process = subprocess.Popen(
            cmd,
            cwd=base_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env
        )
        
        for line in process.stdout:
            log.info(line.strip())
            
        process.wait()
        
        if process.returncode == 0:
            log.info("✅ WEEKLY AUTOMATED CRON JOB FINISHED SUCCESSFULLY!")
        else:
            log.error(f"❌ WEEKLY AUTOMATED CRON JOB FAILED WITH EXIT CODE {process.returncode}")
            sys.exit(process.returncode)
            
    except Exception as e:
        log.critical(f"💥 CRITICAL ERROR DURING CRON EXECUTION: {e}", exc_info=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
