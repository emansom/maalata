# maalata
A [`<canvas>`](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API)
renderer designed to emulate the behavior of classic Flash and Shockwave UIs. It
intentionally recreates the choppy, limited-frame *feel* of vintage web graphics
while maintaining modern performance standards under the hood.

## What is it?
In the early days of the web (around 1999–2007), isometric pixel art games
typically limited their animations to 4–8 frames. This kept the workload
manageable for animators and ran well on the hardware constraints of the time.

When porting classic codebases to modern HTML5 Web APIs, a common problem
arises: the animations become too fluid and fast, losing the nostalgic feel of
the original experience.

Original Flash and Shockwave animation loops were often externally capped at 30
frames per second, further limited by standard 50Hz/60Hz displays and processor
constraints. `maalata` brings back that authentic, janky feel of early web
games.

## How does it work?
`maalata` throttles rendering to a `<canvas>` down to a maximum of 8 frames per
second during animations. It introduces intentional jitter and occasionally
drops frames to simulate slow processor lag and the VSync penalties of older
hardware (such as frame rate halving due to double buffering). When no
animations are active, it optimizes performance by only redrawing when
explicitly told to.

Importantly, this limitation is strictly visual. The browser and OS continue to
process interactivity at native refresh rates, meaning there is zero actual
input lag or VSync penalty introduced.

Under the hood, it is highly optimized:
* **Non-blocking:** Utilizes
  [`OffscreenCanvas`](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)
  to keep the main thread free.
* **Resource Efficient:** Only asks the browser to render when absolutely
  necessary.
* **Memory Management:** Automated cleanup routines to keep the memory footprint
  small.

## Origin and Name
`maalata` is developed for
[HabboWidgets](https://github.com/Quackster/HabboWidgets). Existing rendering
libraries didn't quite fit this highly specific use case, and extracting it into
a standalone library helps prevent code duplication across current and future
retro-style web projects.

*Maalata* is Finnish for "to paint", which perfectly describes what the library
does. The name pays homage to the Finnish roots of the early 2000s web-game
scene (like Habbo Hotel) that inspired this project.
