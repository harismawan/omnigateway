import subprocess

FILE = "apps/gateway/test/routes/rateLimit.test.ts"
NAME = "frees the concurrency slot"

fails = 0
RUNS = 15
for _ in range(RUNS):
    r = subprocess.run(["bun", "test", FILE], capture_output=True, text=True)
    out = r.stdout + r.stderr
    if r.returncode != 0:
        fails += 1
        if fails == 1:
            hit = [line for line in out.split("\n") if "(fail)" in line]
            print("first failure:", *hit, sep="\n  ")
print(f"{FILE}: {fails}/{RUNS} failed")
