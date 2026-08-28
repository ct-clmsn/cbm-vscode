#!/usr/bin/env bash
set -euo pipefail

# install-vscode.sh — Build and install the CBM Search VS Code extension.
#
# Packages tools/cbm-vscode into a .vsix and installs it into VS Code / Cursor.
#
# Usage:
#   ./install-vscode.sh                # build + install into VS Code
#   ./install-vscode.sh --code=code    # use a different 'code' CLI (e.g. cursor)
#   ./install-vscode.sh --no-install   # build the .vsix only, do not install
#   ./install-vscode.sh --server=PATH  # also set cbm.binaryPath to PATH
#
# Environment:
#   VSCE   Override the vsce command (default: npx @vscode/vsce)
#   NODE   Override the node binary (default: node from PATH)

main() {
    VSCE="${VSCE:-}"
    CODE_CLI="code"
    INSTALL=true
    SERVER_PATH=""
    EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd "$EXT_DIR/../.." && pwd)"

    for arg in "$@"; do
        case "$arg" in
            --no-install)  INSTALL=false ;;
            --code=*)      CODE_CLI="${arg#--code=}" ;;
            --server=*)    SERVER_PATH="${arg#--server=}" ;;
            --help|-h)
                echo "Usage: $0 [--no-install] [--code=<cli>] [--server=<path>]"
                echo "  --no-install    Build the .vsix but do not install it"
                echo "  --code=CLI      VS Code CLI to install with (default: code)"
                echo "  --server=PATH   Also write cbm.binaryPath to user settings"
                exit 0
                ;;
            *)
                echo "error: unknown argument: $arg" >&2
                exit 1
                ;;
        esac
    done

    echo "CBM Search VS Code installer"
    echo "  extension dir: $EXT_DIR"

    if ! command -v node >/dev/null 2>&1; then
        echo "error: node is required (https://nodejs.org)" >&2
        exit 1
    fi
    echo "  node:          $(node --version)"

    # 1) Install TypeScript compile dependency.
    echo ""
    echo "== Installing build dependencies (npm install) =="
    (cd "$EXT_DIR" && npm install --no-audit --no-fund)

    # 2) Compile the extension.
    echo ""
    echo "== Compiling TypeScript =="
    (cd "$EXT_DIR" && npm run compile)
    echo "Compiled."

    # 3) Verify the binary path setting if requested.
    if [ -n "$SERVER_PATH" ]; then
        if [ ! -x "$SERVER_PATH" ]; then
            echo "error: server binary not executable: $SERVER_PATH" >&2
            exit 1
        fi
    fi

    # 4) Package into a .vsix.
    VERSION=$(node -p "require('$EXT_DIR/package.json').version")
    vsix="${EXT_DIR}/cbm-search-${VERSION}.vsix"
    echo ""
    echo "== Packaging .vsix =="
    if [ -z "$VSCE" ]; then
        # Use the local/on-demand vsce via npx so no global install is required.
        VSCE="npx --yes @vscode/vsce"
    fi
    $VSCE package --out "$vsix" --allow-missing-repository || {
        echo "error: vsce packaging failed (network may be required to fetch vsce)" >&2
        exit 1
    }
    echo "Packaged: $vsix"

    if [ "$INSTALL" = false ]; then
        echo ""
        echo "Built .vsix only (--no-install). Install it with:"
        echo "  $CODE_CLI --install-extension '$vsix'"
        exit 0
    fi

    # 5) Install into the editor.
    if ! command -v "$CODE_CLI" >/dev/null 2>&1; then
        echo "error: '$CODE_CLI' CLI not found on PATH (pass --code=cursor etc.)" >&2
        exit 1
    fi
    echo ""
    echo "== Installing into VS Code ('$CODE_CLI') =="
    "$CODE_CLI" --install-extension "$vsix"

    # 6) Optionally write the server binary path to user settings.
    if [ -n "$SERVER_PATH" ]; then
        echo ""
        echo "== Setting cbm.binaryPath =="
        "$CODE_CLI" --json >/dev/null 2>&1 || true
        SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"
        # Cursor uses a different path; fall back to the CLI's own settings if needed.
        case "$CODE_CLI" in
            cursor) SETTINGS="$HOME/Library/Application Support/Cursor/User/settings.json" ;;
        esac
        mkdir -p "$(dirname "$SETTINGS")"
        if [ -f "$SETTINGS" ] && grep -q '"cbm.binaryPath"' "$SETTINGS"; then
            node -e "
                const fs=require('fs');
                const p='$SETTINGS';
                const j=JSON.parse(fs.readFileSync(p,'utf8'));
                j['cbm.binaryPath']='$SERVER_PATH';
                fs.writeFileSync(p, JSON.stringify(j,null,4)+'\n');
            "
        else
            printf '\n"cbm.binaryPath": "%s",\n' "$SERVER_PATH" >> "$SETTINGS"
        fi
        echo "Set cbm.binaryPath -> $SERVER_PATH in $SETTINGS"
    fi

    echo ""
    echo "Done! Reload VS Code (Cmd/Ctrl+Shift+P > 'Developer: Reload Window') to use CBM Search."
}

main "$@"
