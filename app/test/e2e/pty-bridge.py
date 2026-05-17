#!/usr/bin/env python3
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios


def main():
    if len(sys.argv) < 5 or sys.argv[3] != "--":
        print("usage: pty-bridge.py <cols> <rows> -- <command> [args...]", file=sys.stderr)
        return 2

    cols = int(sys.argv[1])
    rows = int(sys.argv[2])
    command = sys.argv[4:]

    master, slave = pty.openpty()
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, winsize)

    child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)

    def stop(_signum, _frame):
        try:
            child.terminate()
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    os.set_blocking(master, False)
    os.set_blocking(stdin_fd, False)

    stdin_open = True
    while True:
        if child.poll() is not None and not stdin_open:
            break
        read_fds = [master]
        if stdin_open:
            read_fds.append(stdin_fd)
        try:
            ready, _, _ = select.select(read_fds, [], [], 0.05)
        except InterruptedError:
            continue

        if master in ready:
            try:
                data = os.read(master, 4096)
            except OSError:
                data = b""
            if data:
                os.write(stdout_fd, data)
            elif child.poll() is not None:
                break

        if stdin_fd in ready:
            try:
                data = os.read(stdin_fd, 4096)
            except OSError:
                data = b""
            if data:
                os.write(master, data)
            else:
                stdin_open = False

        if child.poll() is not None:
            try:
                while True:
                    data = os.read(master, 4096)
                    if not data:
                        break
                    os.write(stdout_fd, data)
            except OSError:
                pass
            break

    try:
        os.close(master)
    except OSError:
        pass
    return child.wait()


if __name__ == "__main__":
    raise SystemExit(main())
