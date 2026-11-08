import re

print("--- CLOUDFLARE SITE KEY FIXER ---")
print("Go to Cloudflare -> Turnstile -> Copy your real Site Key.")
real_key = input("Paste your real Site Key here: ").strip()

if not real_key:
    print("❌ No key entered. Exiting.")
    exit()

try:
    content = open('dashboard.html', encoding='utf-8').read()
    
    # Check if the test key is there
    test_key = '1x00000000000000000000AA'
    
    if test_key in content:
        content = content.replace(test_key, real_key)
        open('dashboard.html', 'w', encoding='utf-8').write(content)
        print("✅ Replaced Test Site Key with your Real Site Key!")
    elif real_key in content:
        print("✅ Your real Site Key is already in the file.")
    else:
        # Fallback regex to catch any sitekey
        content = re.sub(r'data-sitekey="[^"]*"', f'data-sitekey="{real_key}"', content)
        open('dashboard.html', 'w', encoding='utf-8').write(content)
        print("✅ Forced Real Site Key into the file!")
        
except FileNotFoundError:
    print("❌ dashboard.html not found. Make sure you are in the right folder.")
