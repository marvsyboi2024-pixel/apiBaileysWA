import requests

url = "https://translation.googleapis.com/language/translate/v2"

headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept-Encoding": "gzip",
    "User-Agent": "okhttp/4.12.0",
    "x-android-package": "evolly.app.translatez",
    "x-android-cert": "ff0ebe4e6358778ec5989e9ff05d735122b8b212"
}

ask = input("Translate: ")

data = {
    "key": "AIzaSyC14KBn3lGyluVW4kY-o1If6ChNxrW_ggQ",
    "q": ask,
    "target": "en",
    "format": "text"
}

response = requests.post(url, headers=headers, data=data)

print(response.text)
