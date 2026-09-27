## Inspiration

> *I know that I hanged on a windy tree*
>
> *nine long nights, wounded with a spear,*
>
> *dedicated to Odin, myself to myself…*
>
> *I took up the runes, screaming I took them.*
>
> Hávamál, stanzas 138 and 139

Odin didn't read the runes. The poem is careful about that: he *took them up*. The Norse didn't call them letters, either. They called them **staves**: marks cut into wood and stone, things you could run a finger along.

Bragi, the god of poetry, came at language from the other end. The Poetic Edda lists his tongue among the things the runes were carved into. For him, speaking and writing were the same act.

We kept coming back to that pair because of a gap that's hard to unsee once you notice it. Almost every piece of assistive technology replaces exactly one sense. Screen readers assume you can hear. Captions assume you can see. People who are deafblind make up somewhere between [0.2% and 2% of the world's population](https://wfdb.eu/wp-content/uploads/2023/03/ENG_WFDB_Executive-Summary_FINAL_PDF.pdf), and most of what gets built for their neighbours simply doesn't apply to them. What does apply tends to cost thousands of dollars and still needs an interpreter in the room.

So we asked a narrow question: what if one small camera and one real braille cell, worn on the hand, could run in both directions?

---

## What it does

Rune & Bragi is a hand-worn camera and a six-dot braille cell, named for the two myths. Rune is the heart of it.

**Rune: the world in.** Point the camera outward. It finds what matters in front of you, a bottle, a person, a sign, and taps it out letter by letter on six solenoids pressed against your fingertip. You feel points, the way braille is meant to be felt, not a buzz. If someone nearby says your name, their sentence goes to the front of the line. Everything else they say is thrown away before anyone sees it.

**Bragi: your hands, out loud.** Turn the camera toward your other hand and fingerspell. It tracks 21 points on your hand in real time, recognizes each letter, and speaks it once you've held the shape steady, so someone who doesn't know fingerspelling can understand you without anyone translating.

Same camera. Same hand. The only thing that changes is which way it's pointing.

---

## Why one cell

Braille displays have rows of cells because readers sweep across whole lines. They're priced like it: the 20-cell [Orbit Reader 20](https://www.orbitresearch.com/products/blindness-products/braille-devices/orbit-reader-20/) is $799, and the 40-cell [Mantis Q40](https://www.aph.org/product/mantis-q40/) is $2,682. They do far more than we do, and we aren't trying to replace them.

One cell is a different thing. It's a tactile notification: a word, an alert, a sentence meant for you. At about a character a second, "bottle" arrives in six beats and a paragraph takes a while. We decided that was something to design around, not something to hide. Rune says less, and chooses carefully what.

---

## How we built it

### The cell

The hardware came first. We could have faked the output with a vibration motor, or a picture of a braille cell on a screen. The point was a real cell pressing real dots into a real finger, and everything else was built to feed it.

Six 12V push-pull solenoids sit in the braille layout, one per dot. A **Raspberry Pi Zero 2 W** drives them, but a Pi pin puts out 3.3V at a few milliamps, and a solenoid switching off throws back a spike that would kill it outright. So every solenoid gets its own **ULN2803** Darlington driver, with all eight of the chip's channels ganged together: inputs to one GPIO, outputs to the solenoid, so no single channel carries the whole coil. The chip's COMMON pin goes to 12V, which gives its built-in flyback diodes somewhere to send the spike. One 12V source, an 8×AA pack, runs the coils directly, and a buck converter steps it down to 5V for the Pi. Every ground is tied together, because without that, "high" means nothing.

![Rune circuit: a 12V pack feeds six solenoids and a buck converter; the Raspberry Pi Zero 2 W drives each solenoid through its own ULN2803 with all eight channels ganged](https://raw.githubusercontent.com/NSP909/IMG2BRL/main/docs/circuit.png)

We verified the map by firing each output one at a time:

| Braille dot | Position | GPIO (BCM) | Header pin |
|:---:|:---|:---:|:---:|
| 1 | top-left | 17 | 11 |
| 2 | middle-left | 25 | 22 |
| 3 | bottom-left | 22 | 15 |
| 4 | top-right | 27 | 13 |
| 5 | middle-right | 23 | 16 |
| 6 | bottom-right | 24 | 18 |

On the Pi, a small Python server built on **gpiozero** takes a six-bit mask and raises exactly those dots. It boots straight into the solenoid controller and the camera stream, so power is all it needs.

This thing presses against skin, so the safety rules live in the Pi, not in the page. No solenoid is ever held on for more than two seconds, whatever anyone asks for. Every pin drops on exit, on error, and on Ctrl+C. A pin lock refuses every actuation until it's released, and because it lives on the device, reloading a browser can't get around it. We wrote those limits before the first pulse ever fired.

All of it, Pi and camera included, came to about **$50**. That's a prototype bill of materials, not a price tag. But it does show that a real tactile cell doesn't have to be priced like medical equipment.

### Rune: from the world to the cell

The Pi's camera streams 720p video to a laptop, because a Pi Zero has nowhere near the compute for what comes next. Three kinds of input feed the cell.

**Objects** go through **YOLO26n-seg**. The model chooses freely from everything it knows, and only then do we check the winner against 18 everyday classes worth feeling.

**Text** is gated before it's read. A tiny local **EAST** detector answers one question in tens of milliseconds: is there a stable block of text here? Only when it says yes twice in a row does the crop go to **Claude Opus** to be transcribed, at most once every five seconds. Tesseract stands in when there's no internet.

**Speech** goes through voice-activity detection and OpenAI transcription, then a name gate. A sentence survives only if it contains the wearer's name or one of their aliases. The rest is dropped before it's shown, stored, or queued.

All three land in one queue. Your name beats text, text beats objects, and something more urgent interrupts whatever is tapping out. Each message starts with its own touch pattern, the full cell ⠿ for speech and a square ⠶ for text, so the wearer knows what kind of message is coming before the first letter arrives.

The web app is the clock. Every cell it shows is also sent to the Pi, so the screen and the finger never disagree. When a letter repeats, like the "ll" in "hello", every pin drops for a beat in between, so you feel two letters instead of one long one.

### Bragi: ASL → speech

Every frame goes through Google's **MediaPipe Hand Landmarker**. It returns 21 3D landmarks per hand: wrist, knuckles, joints, fingertips. Everything downstream works on those 63 numbers and never touches a raw pixel. That turned out to be the most important decision we made on this side.

On top of the landmarks we built two classifiers:

- **A geometric one.** For each finger we measure the angle at the middle knuckle and bucket it as *extended*, *half-bent* or *curled*. Add thumb position, thumb-to-fingertip distance, the spread between index and middle, and the tilt of the wrist, and you can write explicit rules for 19 letters. It needs no training data, and when it's wrong, you can read exactly why.
- **A personal one.** We recorded 60 samples of each of the 24 static letters from a single signer's hand: 1,440 samples. Each one is translated to the wrist and scaled by palm length, then matched against the live frame with k-nearest-neighbours. It covers the whole static alphabet, classifies in well under a millisecond, and it's the one we ship.

A letter is only spoken after it's held steady across consecutive reads, and never twice in a row. Without that, the device stutters every time a hand passes through one shape on its way to another.

We don't call this ASL translation. ASL is a language, with grammar, motion and a face. Bragi reads the 24 static letters of the fingerspelling alphabet, and that's all we claim.

---

## Challenges we ran into

**3.3 volts, 12-volt coils.** A Pi can't drive a solenoid, and a solenoid can kill a Pi. Getting every dot to strike firmly without cooking a chip took six driver chips, forty-eight ganged channels, flyback diodes tied to the right rail, and one shared ground. When a dot doesn't fire, the answer is almost always the ground.

**Solenoids cook themselves.** Hold one on too long and it overheats, and this one is touching someone's finger. So nothing is ever held for more than two seconds, and every pin is forced off on every way the program can end.

**The Pi couldn't find the network.** The Pi Zero 2 W only speaks 2.4 GHz Wi-Fi, and the venue network kept it out of reach of the laptop. A surprising share of the hardware time went into just being able to talk to the board. We ended with three ways in: a USB cable with a fixed address, a phone hotspot, and the Pi hosting its own network.

**The camera sees sideways.** It's mounted on its side, so every frame gets turned 90° before Rune reads it. That fixed Rune and quietly broke Bragi, whose samples had been recorded upright on an ordinary webcam. Letters it knew cold turned to noise until we handed it the frame from before the turn.

**A gate built for sighted users snuck into our own design.** The first version of the text reader asked the user to hold the camera steady on a preview until a crop looked clean, exactly the kind of visual feedback loop a deafblind user cannot close. We rebuilt it to tolerate normal hand motion instead of demanding a held, deliberate pose.

**Restricting the vocabulary backfired.** Limiting the object detector to only its allowed classes meant an unfamiliar object wasn't rejected. It was confidently misidentified as the nearest allowed class instead. The fix wasn't a hardcoded exception. It was letting the model choose freely across its full vocabulary first, and only checking the winner against the allowlist afterward.

**The best model on paper was the worst one in practice.** We started Bragi with five pretrained CNNs, ResNet50V2 and Xception, trained on a public ASL alphabet dataset of roughly 87,000 images. Just getting them to load took a Python downgrade and a legacy-Keras shim. Once they ran, they were close to useless on a live camera. When we fed two of them pure random noise, they answered with near-100% confidence. They had learned the dataset's backgrounds and lighting, not hands. We cut all five.

**Some letters are the same letter.** H and U share an identical handshape: two fingers out, two curled. The only difference is that H is signed with the hand turned sideways. Our finger-angle features were rotation-invariant by design, which meant they were throwing away the one signal that separates the two. We had to put wrist tilt back in on purpose.

**Five fists.** A, S, T, N and M are all closed hands. What separates them is where the thumb goes: beside the fingers, across them, between the first two, under two, under three. Telling those apart means estimating depth from a single camera, which is the noisiest thing MediaPipe gives you. It's still the weakest part of the geometric classifier.

**J and Z move.** They're traced through the air. No single-frame classifier can read them, however good it is. We chose to say that plainly rather than fake it.

| Approach | Letters covered | Needs training data | Held up on a live camera |
|:---|:---:|:---|:---|
| Pretrained CNNs (5 models) | 26 on paper | Pre-trained, ~87k images | No |
| Geometric rules | 19 | None | Yes |
| Personal KNN | 24 (all static) | 1,440 samples, one signer | Yes, for its signer |

---

## Accomplishments that we're proud of

- A real six-dot braille cell: six solenoids and six driver chips, wired by hand, pressing actual dots into a fingertip. No vibration motor standing in for one.
- The whole tactile build, Pi and camera included, for about $50.
- Safety that lives in the hardware, written before the first pulse ever fired.
- Objects, printed text and a spoken name, all arriving on that cell, live.
- Throwing away every sentence that isn't meant for the wearer, instead of transcribing the room.
- The full static fingerspelling alphabet, live, from a classifier trained on one person's hand, where five deep networks trained on tens of thousands of images failed.
- Catching our own sighted-user assumption before it shipped, not after.
- Building for a group almost nothing is built for, and taking that seriously enough to say clearly what the device can't do yet.

---

## What we learned

Hardware for the body is a different discipline. A bug in software shows the wrong letter. A bug in a solenoid driver can burn someone's hand. The safety limits had to exist before the first pulse, and they had to live on the device, where no browser could talk its way past them.

The model built for everyone didn't work for the person in front of us. The one built from a single person's hand did.

For most software, generalization is the goal. For assistive technology worn on one person's body, it may be the wrong goal entirely. A device that has learned how *you* sign, the angle of your wrist, how far your thumb tucks, is worth more than one that's roughly right about everybody.

We learned how easily a sighted assumption hides inside an interface. "Hold the camera steady until the preview looks clean" reads as a reasonable default, right up until you remember the person using it can't see the preview at all.

And we learned to trust landmarks over pixels. Reducing a hand to 63 numbers stripped out background, lighting, skin tone and camera quality in one step, and left everything after it simple enough to debug by reading it.

---

## What's next for Rune & Bragi

- **More cells.** One cell shows one letter at a time. A row would let a reader feel a whole word at once.
- **A smaller dot.** Tighter spacing, closer to real braille, and quieter than a solenoid's click.
- **A real wearable.** An enclosure, a proper battery, and recognition moved off the laptop, so the whole device is a camera, a cell, a speaker and a strap.
- **Fewer words, safely.** "Ritesh, your ride is waiting outside at the east entrance" could arrive as **RIDE, EAST ENTRANCE**, but only with the wearer in control of what gets cut.
- **J and Z**, by matching short landmark sequences with dynamic time warping instead of reading single frames.
- **Words, not letters**, by buffering fingerspelled letters and speaking the whole word at a pause.
- **Deafblind testers.** Everything so far was built *for* deafblind people. The next version has to be built *with* them.

Rune brings the world into the hand.

Bragi gives the hand a voice.
