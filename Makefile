.RECIPEPREFIX := >
UUID   := i3-shell@troja
EXTDIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: build build-test install uninstall pack test integration clean

build:
> npm run build

build-test:
> npm run build:test

install: build
> mkdir -p "$(dir $(EXTDIR))"
> rm -rf "$(EXTDIR)"
> ln -s "$(CURDIR)/dist" "$(EXTDIR)"
> @echo "installed -> $(EXTDIR)  (log out and back in to load new code, then: gnome-extensions enable $(UUID))"

uninstall:
> rm -rf "$(EXTDIR)"

pack: build
> cd dist && zip -qr "../$(UUID).zip" . && cd .. && echo "wrote $(UUID).zip"

test:
> npm test

integration:
> npm run test:integration

clean:
> rm -rf dist "$(UUID).zip"
