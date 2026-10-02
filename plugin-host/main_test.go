package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"

	"github.com/confighub/sdk/core/plugin"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Dir(filepath.Dir(file))
}

func TestSourceManifestAndSDKRoutedManifest(t *testing.T) {
	root := repoRoot(t)
	source, err := plugin.Read(root)
	if err != nil {
		t.Fatal(err)
	}
	if source == nil {
		t.Fatal("checked-in source manifest missing")
	}
	wantEntrypoints := map[string]string{
		"config": "bin/cub-config",
		"app":    "bin/cub-app",
		"stack":  "bin/cub-stack",
		"fleet":  "bin/cub-fleet",
	}
	for _, command := range source.Commands {
		if command.Entrypoint != wantEntrypoints[command.Name] || len(command.Args) != 0 {
			t.Errorf("source install route for %s = %q %#v", command.Name, command.Entrypoint, command.Args)
		}
	}
	routed, err := routedManifest(root)
	if err != nil {
		t.Fatal(err)
	}
	if routed.Name != source.Name || routed.Version != source.Version || len(routed.Commands) != len(source.Commands) {
		t.Fatalf("routed manifest metadata differs from source: %#v vs %#v", routed, source)
	}
	for i, command := range routed.Commands {
		original := source.Commands[i]
		if command.Name != original.Name || command.Summary != original.Summary {
			t.Errorf("routed command %d changed canonical metadata: %#v vs %#v", i, command, original)
		}
		if command.Entrypoint != "bin/cub-workshop" || len(command.Args) != 1 || command.Args[0] != dispatchPrefix+command.Name {
			t.Errorf("routed command %s = %#v", command.Name, command)
		}
	}
}

func TestInstallAndUpgradeHooksWriteRoutedManifest(t *testing.T) {
	for _, phase := range []string{plugin.HookInstall, plugin.HookUpgrade} {
		t.Run(phase, func(t *testing.T) {
			dir := t.TempDir()
			data, err := os.ReadFile(filepath.Join(repoRoot(t), plugin.ManifestFileName))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, plugin.ManifestFileName), data, 0o644); err != nil {
				t.Fatal(err)
			}
			t.Setenv(plugin.EnvHook, phase)
			t.Setenv(plugin.EnvDir, dir)
			if err := handleHook(); err != nil {
				t.Fatal(err)
			}
			written, err := plugin.Read(dir)
			if err != nil {
				t.Fatal(err)
			}
			source, sourceErr := plugin.Read(repoRoot(t))
			if sourceErr != nil {
				t.Fatal(sourceErr)
			}
			if written == nil || source == nil || written.Version != source.Version || len(written.Commands) != 4 {
				t.Fatalf("unexpected generated manifest: %#v", written)
			}
			for _, command := range written.Commands {
				if command.Entrypoint != "bin/cub-workshop" || len(command.Args) != 1 || command.Args[0] != dispatchPrefix+command.Name {
					t.Errorf("hook did not route %s: %#v", command.Name, command)
				}
			}
		})
	}
}

func TestRoutedManifestRejectsUnexpectedCommandSet(t *testing.T) {
	dir := t.TempDir()
	data := []byte("name: workshop\nversion: 1\ncommands:\n  - name: config\n    summary: config\n    entrypoint: bin/cub-config\n")
	if err := os.WriteFile(filepath.Join(dir, plugin.ManifestFileName), data, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := routedManifest(dir); err == nil || !strings.Contains(err.Error(), "missing Workshop command") {
		t.Fatalf("expected missing command error, got %v", err)
	}
}

func TestRunRoutesAndPreservesArgumentsAndEnvironment(t *testing.T) {
	for command, script := range commandScripts {
		t.Run(command, func(t *testing.T) {
			var stderr bytes.Buffer
			var gotPath string
			var gotArgs, gotEnv []string
			code := run([]string{dispatchPrefix + command, "subcommand", "--flag", "value with spaces"}, []string{"CUB_TOKEN=secret", "OTHER=kept"}, &stderr,
				func(path string, args, env []string) error {
					gotPath, gotArgs, gotEnv = path, args, env
					return nil
				},
				func(name string) (string, error) { return "/usr/local/bin/node", nil },
				func() (string, error) { return "/plugin/bin/cub-workshop", nil },
			)
			if code != 0 {
				t.Fatalf("run exit = %d, stderr %s", code, stderr.String())
			}
			if gotPath != "/usr/local/bin/node" {
				t.Errorf("exec path = %s", gotPath)
			}
			wantArgs := []string{"/usr/local/bin/node", filepath.Join("/plugin/bin", script), "subcommand", "--flag", "value with spaces"}
			if fmt.Sprint(gotArgs) != fmt.Sprint(wantArgs) {
				t.Errorf("exec args = %#v, want %#v", gotArgs, wantArgs)
			}
			if fmt.Sprint(gotEnv) != fmt.Sprint([]string{"CUB_TOKEN=secret", "OTHER=kept"}) {
				t.Errorf("exec environment = %#v", gotEnv)
			}
		})
	}
}

func TestRunReportsMissingNodeAndInvalidRoute(t *testing.T) {
	var stderr bytes.Buffer
	code := run([]string{dispatchPrefix + "config"}, nil, &stderr, func(string, []string, []string) error {
		t.Fatal("exec should not happen when Node is missing")
		return nil
	}, func(string) (string, error) { return "", exec.ErrNotFound }, func() (string, error) { return "", nil })
	if code != 127 || !strings.Contains(stderr.String(), "Node.js is required") {
		t.Fatalf("missing Node result = %d, %q", code, stderr.String())
	}

	stderr.Reset()
	code = run([]string{dispatchPrefix + "nope"}, nil, &stderr, func(string, []string, []string) error {
		t.Fatal("exec should not happen for an invalid route")
		return nil
	}, func(string) (string, error) { return "node", nil }, func() (string, error) { return "", nil })
	if code != 2 || !strings.Contains(stderr.String(), "unknown command route") {
		t.Fatalf("invalid route result = %d, %q", code, stderr.String())
	}
}

func TestRouteHelperProcess(t *testing.T) {
	if os.Getenv("WORKSHOP_ROUTER_CHILD") != "1" {
		return
	}
	node := os.Getenv("WORKSHOP_ROUTER_NODE")
	self := os.Getenv("WORKSHOP_ROUTER_SELF")
	code := run([]string{dispatchPrefix + "config", "arg one", "--tail"}, os.Environ(), os.Stderr, syscall.Exec,
		func(string) (string, error) { return node, nil },
		func() (string, error) { return self, nil })
	os.Exit(code)
}

func TestExecPreservesStdinEnvironmentArgsAndExit(t *testing.T) {
	dir := t.TempDir()
	self := filepath.Join(dir, "bin", "cub-workshop")
	if err := os.MkdirAll(filepath.Dir(self), 0o755); err != nil {
		t.Fatal(err)
	}
	entrypoint := filepath.Join(dir, "bin", "cub-config")
	if err := os.WriteFile(entrypoint, []byte("#!/bin/sh\nprintf 'route:%s\\n' \"$0\"\nprintf 'env:%s\\n' \"$WORKSHOP_ROUTER_VALUE\"\nprintf 'args:%s|%s\\n' \"$1\" \"$2\"\ncat\nexit 23\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := routerChild(t, self, entrypoint, false)
	cmd.Stdin = strings.NewReader("input-through-stdin\n")
	out, err := cmd.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 23 {
		t.Fatalf("child exit = %v; output %s", err, out)
	}
	for _, want := range []string{
		"route:" + entrypoint,
		"env:preserved",
		"args:arg one|--tail",
		"input-through-stdin",
	} {
		if !strings.Contains(string(out), want) {
			t.Errorf("child output missing %q: %s", want, out)
		}
	}
}

func TestExecPreservesSignalTermination(t *testing.T) {
	dir := t.TempDir()
	self := filepath.Join(dir, "bin", "cub-workshop")
	if err := os.MkdirAll(filepath.Dir(self), 0o755); err != nil {
		t.Fatal(err)
	}
	entrypoint := filepath.Join(dir, "bin", "cub-config")
	if err := os.WriteFile(entrypoint, []byte("#!/bin/sh\nkill -TERM $$\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := routerChild(t, self, entrypoint, true)
	err := cmd.Run()
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("expected signal termination, got %v", err)
	}
	status, ok := exitErr.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() || status.Signal() != syscall.SIGTERM {
		t.Fatalf("child status = %#v, want SIGTERM", exitErr.Sys())
	}
}

func routerChild(t *testing.T, self, entrypoint string, signal bool) *exec.Cmd {
	t.Helper()
	node := filepath.Join(filepath.Dir(entrypoint), "node")
	content := "#!/bin/sh\nexec /bin/sh \"$@\"\n"
	if err := os.WriteFile(node, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestRouteHelperProcess$")
	cmd.Env = append(os.Environ(),
		"WORKSHOP_ROUTER_CHILD=1",
		"WORKSHOP_ROUTER_NODE="+node,
		"WORKSHOP_ROUTER_SELF="+self,
		"WORKSHOP_ROUTER_VALUE=preserved",
	)
	return cmd
}
