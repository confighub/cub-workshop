// Command cub-workshop is the cub plugin hook and router for the Node.js
// Workshop commands. The command implementations remain in ../bin.
package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/confighub/sdk/core/plugin"
)

const dispatchPrefix = "--workshop-command="

var commandScripts = map[string]string{
	"config": "cub-config",
	"app":    "cub-app",
	"stack":  "cub-stack",
	"fleet":  "cub-fleet",
}

func main() {
	if plugin.Phase() != "" {
		if err := handleHook(); err != nil {
			fmt.Fprintln(os.Stderr, "cub-workshop:", err)
			os.Exit(1)
		}
		return
	}
	os.Exit(run(os.Args[1:], os.Environ(), os.Stderr, syscall.Exec, exec.LookPath, os.Executable))
}

func handleHook() error {
	m, err := routedManifest(os.Getenv(plugin.EnvDir))
	if err != nil {
		return err
	}
	handled, err := plugin.HandleHook(m)
	if err != nil {
		return err
	}
	if !handled {
		return fmt.Errorf("plugin hook was not handled")
	}
	return nil
}

type lookPath func(string) (string, error)
type execProcess func(string, []string, []string) error
type executablePath func() (string, error)

// routedManifest transforms the checked-in source manifest into the release
// manifest. It keeps command names, descriptions, and version canonical in
// cub-plugin.yaml while routing every command through this host.
func routedManifest(dir string) (plugin.Manifest, error) {
	source, err := plugin.Read(dir)
	if err != nil {
		return plugin.Manifest{}, fmt.Errorf("read source plugin manifest: %w", err)
	}
	if source == nil {
		return plugin.Manifest{}, fmt.Errorf("source plugin manifest is missing from %s", dir)
	}
	seen := make(map[string]bool, len(commandScripts))
	for i := range source.Commands {
		command := &source.Commands[i]
		if _, ok := commandScripts[command.Name]; !ok {
			return plugin.Manifest{}, fmt.Errorf("unsupported Workshop command %q in source manifest", command.Name)
		}
		if seen[command.Name] {
			return plugin.Manifest{}, fmt.Errorf("duplicate Workshop command %q in source manifest", command.Name)
		}
		seen[command.Name] = true
		command.Entrypoint = "bin/cub-workshop"
		command.Args = []string{dispatchPrefix + command.Name}
	}
	for name := range commandScripts {
		if !seen[name] {
			return plugin.Manifest{}, fmt.Errorf("source plugin manifest is missing Workshop command %q", name)
		}
	}
	return *source, nil
}

// run resolves a routed command and replaces this process with Node. The
// caller's file descriptors and environment stay attached to the replacement,
// preserving stdin, signals, and the Node script's exact exit status.
func run(args, environ []string, stderr io.Writer, replaceProcess execProcess, findExecutable lookPath, executable executablePath) int {
	if len(args) == 0 || !strings.HasPrefix(args[0], dispatchPrefix) {
		fmt.Fprintln(stderr, "cub-workshop: missing command route; invoke this plugin through cub")
		return 2
	}
	command := strings.TrimPrefix(args[0], dispatchPrefix)
	script, ok := commandScripts[command]
	if !ok {
		fmt.Fprintf(stderr, "cub-workshop: unknown command route %q\n", command)
		return 2
	}
	node, err := findExecutable("node")
	if err != nil {
		fmt.Fprintf(stderr, "cub-workshop: Node.js is required to run cub %s: %v\n", command, err)
		return 127
	}
	self, err := executable()
	if err != nil {
		fmt.Fprintf(stderr, "cub-workshop: locate plugin executable: %v\n", err)
		return 1
	}
	entrypoint := filepath.Join(filepath.Dir(self), script)
	argv := append([]string{node, entrypoint}, args[1:]...)
	if err := replaceProcess(node, argv, environ); err != nil {
		fmt.Fprintf(stderr, "cub-workshop: start Node.js for cub %s: %v\n", command, err)
		return 127
	}
	return 0
}
