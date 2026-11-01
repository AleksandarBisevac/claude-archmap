Use the architecture-mapping plugin installed in this session for the whole task.

Build an architecture map of the repository whose location is in the environment variable <ENV_NAME>. Read the code of that repository; do not ask me questions.

The map must contain:

1. The main components of the system, with the typed relations between them (for example calls, reads from, writes to, publishes to, depends on), each relation naming its source, its target and its type.
2. The database entities, each with its fields.
3. At least three request or data flows, each written as a sequence of steps between the components, from the entry point to the last component or store that is touched.
4. A file reference as evidence for every component: the path of the file, or of the folder, that implements it.

Write the result under docs/architecture of that repository, as files. Do not leave the result only in your answer.

End the run with a short summary of what was produced and where it was written.
