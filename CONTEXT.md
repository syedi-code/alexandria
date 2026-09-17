# alexandria

The backend. One database holding two bodies of work: a personal daily record,
and a study of the genealogy of ideas. Two frontends read it — **stylus** for
the writing, **scribe** for the works — and neither holds data of its own.

This file is the authority on what words mean here. The `_Avoid_` lines are not
suggestions; a term listed there has been rejected, usually because it was
ambiguous or over-claimed.

## Language

### Writing

**Thought**: A dated personal entry about the writer's own life, optionally
carrying a mood score and mood tags. Personal, not intellectual. _Avoid_:
journal entry, log, post

**Note**: A compression of someone else's idea into the writer's own words —
usually one or two sentences, usually attached to a Book. Not a citation; a
restatement. _Avoid_: highlight, annotation, marginalia

**Quote**: Verbatim text by another person, attributed to a Work and a Creator.
Never rewritten, because rewriting it would make it a Note. _Avoid_: excerpt,
passage

**Essay**: A short composed piece of prose that embeds Quotes and Books inline
and argues something. The only place the writer's own argument lives. _Avoid_:
article, post, piece

**Thread** _(retired)_: A named, ordered collection of Notes, Quotes and
Thoughts. Superseded by Essay, which can hold both the juxtaposition and the
argument for it. Not to be revived — the naming slot was too small to hold a
reason.

### Works

**Work**: Anything a Note or Quote can attach to — a Book, a lecture, an
article, a film. The core entity; carries a `kind` that says which. _Avoid_:
item, resource, title

**Book**: A Work whose kind is `book`. Not a separate entity — the only
fully-modelled kind on day one, and a strict subset of Work. _Avoid_: volume,
publication

**Creator**: The person a Work is attributed to. One Creator has many Works.
_Avoid_: author, writer

**Document**: A concrete file a Work exists as — a PDF, one particular edition
or translation. Pagination belongs here, not to the Work: "page 47" means
nothing until you know which Document. _Avoid_: file, edition, copy, upload

**Transcription**: One extraction of a Document's text — by reading its PDF text
layer, or later by a model reading page images. A Document may have several; one
is current. They are compared, never merged. _Avoid_: OCR, parse, text dump

**Page**: One page of one Transcription: its text, numbered by its position in
the PDF. The number printed on the paper is derived from the Document's page
offset. _Avoid_: sheet, leaf, scan

**Citation**: A pointer from a claim to a Page, carrying the verbatim words the
claim relies on, and whether those words were found there: verified, unverified,
or unverifiable (the page has no text). Not a Quote — a Quote is Writing someone
chose to keep; a Citation is evidence an answer had to show. _Avoid_: reference,
source, footnote

### Conversations

**Conversation**: One person's exchange with Scribe: their questions and its
cited answers. _Avoid_: chat, thread, session

**Page handle**: The short name — P1, P2, … — a Page gets the first time a
Conversation's tools show it to a model. A Citation in an answer names its Page
by handle, so it can only point at a Page the model was actually shown. _Avoid_:
page id, reference

### Genealogy _(future separate app)_

**Genealogy**: A named, ordered sequence of Entries tracing a lineage of ideas
across centuries. A real object that can be created, titled, and presented.
Prose the writer authors, not a rendering of anything derived. _Avoid_: the map,
graph, canon object, timeline

**Entry**: A year and a sentence — one moment in a Genealogy. The sentence is
free prose and carries the whole claim; there is no pair, no direction, and
nothing typed about it. An Entry may name people or works the corpus has never
heard of. _Avoid_: item, node, event, step, link

**Link**: An adjacency the app noticed: two entities that co-occur in the
corpus. Carries a count and its sources, and asserts nothing — derived, dense,
never maintained by hand, and never phrased in the writer's voice. Its only job
is to suggest that a Genealogy might be worth writing. A Link never becomes an
Entry. _Avoid_: edge, connection, relation, found link, suggestion

**Noise**: A Found link produced by a defect in extraction rather than by real
adjacency — for example a surname collision between two different people.
Dismissible, and never silently upgraded into a claim. _Avoid_: false positive,
bad link

### The boundary

**Works**: The record of what exists in the world — Works, their Creators, cover
and media images, PDFs, and the text extracted from them. Shared, admin-curated,
read-mostly, and true regardless of who is reading. Knows nothing about anyone's
writing. _Avoid_: catalogue, corpus, the library, books table, reference data

**Writing**: Everything a person has set down themselves — Thoughts, Notes,
Quotes and Essays. Private to whoever wrote it. Points at Works; Works never
points back. _Avoid_: corpus, journal, content, user data

**Conversations**: One person's exchanges with Scribe. Private to their owner,
like Writing, but not Writing — the person did not write the answers. Points at
Works through Citations; Works never points back, and Writing and Conversations
never point at each other. _Avoid_: chat history, logs

**Platform**: What every domain stands on and neither owns — identity, sessions,
the audit log, and the field limits every schema is built from. Imports neither
Works nor Writing, which is what keeps it honest. _Avoid_: shared, common,
utils, infra
