# Owner's rubric

The owner scores every map once, from 1 to 5 on each of four axes, after reading the artifact and the repository's
key-component checklist (private, kept under `.private/reference/` of the archmap checkout and never tracked). The
four scores are recorded as they are; they are not averaged into one number. Level 5 is the best, level 1 the worst,
and a level is given only when its sentence is true of the whole artifact.

## Coverage of the real components

5. Every key component of the checklist is present under a recognisable name, and nothing large is missing.
4. All but one or two key components are present; the missing ones are small.
3. About two thirds of the key components are present; a whole layer or area of the system is thin.
2. Fewer than half of the key components are present, or the components are generic boxes that fit any project.
1. Few or none of the real components can be found; the map describes an imagined system.

## Correctness of the relations

5. Every relation checked against the code is real, has the right direction and the right type, and none is invented.
4. Nearly all relations are correct; one or two have a wrong type or direction.
3. Most relations are correct, but several are wrong, missing between neighbouring components, or untyped.
2. Many relations are wrong or invented, or the relations mostly state only that two things are connected.
1. The relations are absent or contradict the code.

## Usefulness of the flows

5. Each flow follows a real path through the code from entry point to store, with steps a new engineer could trace to files, and the flows cover different parts of the system.
4. The flows are real and traceable; one is shallow or repeats another.
3. The flows are plausible but skip steps, or only some steps can be traced to files.
2. The flows are generic (a request goes to a server and a database) and could be written without reading the code.
1. There are no flows, or they describe paths that do not exist.

## Readability of the artifact

5. A new engineer finds the components, entities and flows in minutes: the structure is navigable, the diagrams or tables are legible, and the form suits the content.
4. Easy to read with small faults, such as a crowded diagram, an unclear legend or a long file without a table of contents.
3. Readable with effort: the content is there but hard to navigate, or the form fights the content.
2. Hard to read: the diagrams do not render or are crowded beyond use, or the structure is hidden.
1. Not usable as a document: unrendered, truncated or scattered across files with no entry point.
