import os,sys,pathlib
dest=pathlib.Path(sys.argv[1]);dest.mkdir(exist_ok=True)
(dest/f'opencode.json.{os.getpid()}.tmp').symlink_to('/dev/full')
os.execvp(sys.argv[2],sys.argv[2:])
