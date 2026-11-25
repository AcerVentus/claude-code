// InSys launcher.
//
// InSys.exe is this small program with a ZIP file embedded in it. The ZIP holds
// an unmodified copy of the official Python runtime for Windows and the InSys
// application (insys.py and its web folder).
//
// On first start the launcher unpacks the ZIP into the user's local application
// data folder (once per version; later starts skip straight to the next step),
// then runs InSys with that private Python. Nothing is installed system-wide,
// nothing is downloaded, and the user's own Python, if any, is not touched.
//
// The launcher tells InSys which folder InSys.exe is in (INSYS_HOME) so that
// the database is kept beside the program, not in the unpacked runtime.
//
// Built by ../build_exe.py, which writes payload.zip and payload.sha256 next to
// this file before compiling.
package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"time"
)

//go:embed payload.zip
var payload []byte

//go:embed payload.sha256
var payloadHash string

const (
	pythonPath = "python/python.exe"
	scriptPath = "app/insys.py"
	doneMarker = ".complete"
)

func main() {
	code, err := run()
	if err != nil {
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "  InSys could not start.")
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "  "+err.Error())
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "  Things to check:")
		fmt.Fprintln(os.Stderr, "   - there is free space on this computer's main drive;")
		fmt.Fprintln(os.Stderr, "   - antivirus software has not blocked or removed part of InSys")
		fmt.Fprintln(os.Stderr, "     (if it has, allow InSys.exe and start it again).")
		fmt.Fprintln(os.Stderr)
		fmt.Fprint(os.Stderr, "  Press Enter to close this window. ")
		bufio.NewReader(os.Stdin).ReadString('\n')
		os.Exit(1)
	}
	os.Exit(code)
}

func run() (int, error) {
	exe, err := os.Executable()
	if err != nil {
		return 1, fmt.Errorf("cannot find where InSys.exe is: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	home := filepath.Dir(exe)

	id := strings.TrimSpace(payloadHash)
	if len(id) < 16 {
		return 1, errors.New("this copy of InSys.exe is incomplete; please get a fresh copy")
	}
	id = id[:16]

	cache, err := os.UserCacheDir() // %LocalAppData% on Windows
	if err != nil {
		return 1, fmt.Errorf("cannot find the local application data folder: %w", err)
	}
	base := filepath.Join(cache, "InSys", "runtime")
	dir := filepath.Join(base, id)

	if !ready(dir) {
		fmt.Println()
		fmt.Println("  Preparing InSys for first use. This takes a few seconds...")
		if err := install(base, dir); err != nil {
			return 1, fmt.Errorf("could not unpack InSys into %s: %w", dir, err)
		}
	}
	removeOtherVersions(base, id)

	python := filepath.Join(dir, filepath.FromSlash(pythonPath))
	args := append([]string{filepath.Join(dir, filepath.FromSlash(scriptPath))}, os.Args[1:]...)
	cmd := exec.Command(python, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = append(environment(), "INSYS_PACKAGED=1", "INSYS_HOME="+home)

	// Ctrl+C reaches InSys itself, which shuts down cleanly; the launcher only
	// has to stay alive until that is done. Receiving the signal and discarding
	// it is used rather than signal.Ignore, which on Windows does not stop the
	// default "terminate the process" handling.
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	go func() {
		for range interrupts {
		}
	}()

	err = cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), nil
	}
	if err != nil {
		return 1, fmt.Errorf("could not start InSys (%s): %w", python, err)
	}
	return 0, nil
}

// ready reports whether dir holds a completely unpacked copy.
func ready(dir string) bool {
	for _, name := range []string{doneMarker, pythonPath, scriptPath} {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(name))); err != nil {
			return false
		}
	}
	return true
}

// install unpacks the payload into dir. A lock file stops two copies of the
// launcher (an impatient second double-click) from unpacking at the same time.
func install(base, dir string) error {
	if err := os.MkdirAll(base, 0o755); err != nil {
		return err
	}
	lock := dir + ".lock"
	for attempt := 0; ; attempt++ {
		file, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			file.Close()
			break
		}
		if ready(dir) {
			return nil // the other copy finished the job
		}
		if info, statErr := os.Stat(lock); statErr == nil && time.Since(info.ModTime()) > 3*time.Minute {
			os.Remove(lock) // left behind by a copy that was interrupted
			continue
		}
		if attempt >= 400 {
			return fmt.Errorf("timed out waiting for another copy of InSys to finish starting (%w)", err)
		}
		time.Sleep(500 * time.Millisecond)
	}
	defer os.Remove(lock)

	if ready(dir) {
		return nil
	}
	if err := os.RemoveAll(dir); err != nil { // an earlier, interrupted attempt
		return err
	}
	if err := unpack(dir); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, doneMarker), []byte(strings.TrimSpace(payloadHash)+"\n"), 0o644)
}

func unpack(dest string) error {
	reader, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		return err
	}
	for _, entry := range reader.File {
		name := filepath.FromSlash(entry.Name)
		if !filepath.IsLocal(name) {
			return fmt.Errorf("unexpected file name in package: %q", entry.Name)
		}
		target := filepath.Join(dest, name)
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := unpackFile(entry, target); err != nil {
			return err
		}
	}
	return nil
}

func unpackFile(entry *zip.File, target string) error {
	mode := entry.Mode().Perm()
	if mode == 0 {
		mode = 0o644
	}
	source, err := entry.Open()
	if err != nil {
		return err
	}
	defer source.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, source); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// removeOtherVersions deletes runtimes unpacked by other versions of InSys.exe.
// Failures are ignored: an older copy may still be running.
func removeOtherVersions(base, keep string) {
	entries, err := os.ReadDir(base)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() || name == keep || len(name) != len(keep) || !isHex(name) {
			continue
		}
		os.RemoveAll(filepath.Join(base, name))
	}
}

func isHex(text string) bool {
	for _, c := range text {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}

// environment is the current environment without PYTHON* settings, which are
// meant for the user's own Python and must not steer the private one.
func environment() []string {
	var kept []string
	for _, entry := range os.Environ() {
		if strings.HasPrefix(strings.ToUpper(entry), "PYTHON") {
			continue
		}
		kept = append(kept, entry)
	}
	return kept
}
