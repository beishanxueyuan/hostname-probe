from_symlink_* files are symlinks resolved at package time.
from_buildcmd_* files are written by BuildCmd at build time.
If both hostnames match, git clone + package + BuildCmd share the same host/container.
