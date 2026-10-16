import json
import base64
import subprocess
import io
from PIL import Image

cmd = ['npx.cmd', 'wrangler', 'd1', 'execute', 'aurastudio-prod-db', '--remote', '--json', '--command', "SELECT input_image_url, output_image_url FROM generations WHERE id = 'task_785322_jx32';"]
proc = subprocess.run(cmd, capture_output=True, text=True, shell=True)
data = json.loads(proc.stdout)
row = data[0]['results'][0]
in_b64 = row['input_image_url'].split('base64,')[1]
out_b64 = row['output_image_url'].split('base64,')[1]

in_img = Image.open(io.BytesIO(base64.b64decode(in_b64)))
out_img = Image.open(io.BytesIO(base64.b64decode(out_b64)))

print(f"Task 785322 input size: {in_img.size}")
print(f"Task 785322 output size: {out_img.size}")
in_img.save('tests/red_in.png')
out_img.save('tests/red_out.png')
