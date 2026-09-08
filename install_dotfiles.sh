#!/usr/bin/env bash
set -euo pipefail

DOTFILES_DIR="$HOME/dotfiles"

# Folders in ~/.config to symlink (repo name == home name)
config_folders=(i3 picom polybar rofi alacritty)

# Helper: replace an existing symlink, or create a new one, pointing at src
link() {
    local src="$1"
    local dst="$2"

    if [ ! -e "$src" ]; then
        echo "ERROR: source $src does not exist" >&2
        exit 1
    fi

    if [ -L "$dst" ]; then
        echo "Replacing existing symlink $dst"
        rm "$dst"
    elif [ -e "$dst" ]; then
        echo "ERROR: $dst exists and is not a symlink, refusing to delete it" >&2
        exit 1
    fi

    ln -s "$src" "$dst"
    echo "Linked $dst -> $src"
}

# Ensure ~/.config exists
mkdir -p "$HOME/.config"

# Symlink ~/.config folders
for folder in "${config_folders[@]}"; do
    link "$DOTFILES_DIR/$folder" "$HOME/.config/$folder"
done

# Symlink ~ folders where repo name != home name
link "$DOTFILES_DIR/pi" "$HOME/.pi"

echo "Done."
