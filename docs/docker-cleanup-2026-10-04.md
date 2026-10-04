# Docker cache cleanup — October 4, 2026

Executed `docker builder prune --all --force`, followed by `docker image prune --force`.

| Item | Reclaimed according to Docker |
| --- | ---: |
| Build cache | 30.37 GB |
| Dangling images | 7.613 GB |
| Remaining build cache | 0 B |

Container and volume pruning were not run. PostgreSQL project records and the latest AI conversation were checked after cleanup and remain present. The frontend, backend, AI service, database and remote browser tunnel are running.

## Windows storage remains separate

The Docker data file is `C:\Users\adiro\AppData\Local\Docker\wsl\disk\docker_data.vhdx`. Its physical file length is still 67.81 GiB, while the mounted Linux data filesystem reports about 34.4 GiB used. C: has 3.75 GiB free at the final check. Docker's reclaimed cache total is therefore **not** a measurement of newly freed Windows disk space.

Ran `fstrim --verbose /mnt/docker-desktop-disk` in the Docker WSL distribution; it reported 1.4 GiB trimmed, with no meaningful decrease in Windows file length. This shell is not an administrator session, so offline VHD compaction was not performed.

Microsoft documents that dynamically expanding VHD files do not automatically shrink after files are deleted. [Compaction requires a detached disk or a read-only attachment](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact-vdisk). Docker must be fully stopped before performing offline disk maintenance; see [Docker's data disk documentation](https://docs.docker.com/desktop/settings-and-maintenance/backup-and-restore/).

The remaining physical-space recovery requires an administrator PowerShell session: save work in WSL, quit Docker Desktop, shut down WSL, then compact this exact existing data disk with DiskPart or Optimize-VHD and restart Docker Desktop. Do not delete the VHD, reset Docker, unregister data distributions or prune volumes to achieve compaction.
