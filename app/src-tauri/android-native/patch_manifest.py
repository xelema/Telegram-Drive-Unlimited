import sys
import re

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    s = f.read()

perms = [
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
    "android.permission.POST_NOTIFICATIONS",
]
inject = ""
for perm in perms:
    if perm not in s:
        inject += f'    <uses-permission android:name="{perm}" />\n'
if inject:
    s = re.sub(r"(<manifest[^>]*>\s*\n)", r"\1" + inject, s, count=1)

if "UploadForegroundService" not in s:
    svc = (
        "        <service\n"
        '            android:name="com.cameronamer.telegramdrive.UploadForegroundService"\n'
        '            android:exported="false"\n'
        '            android:foregroundServiceType="dataSync" />\n'
    )
    s = s.replace("</application>", svc + "    </application>")

with open(path, "w", encoding="utf-8") as f:
    f.write(s)
print("manifest patched")
