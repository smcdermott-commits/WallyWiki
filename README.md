# WallyWiki

**A student-built resource hub for Harvey Mudd College.**

WallyWiki brings Harvey Mudd's scattered campus resources into one searchable, organized place. Instead of digging through different department pages, club websites, and campus portals, students can use one site to find what they need.

The name comes from **Wally the Wart**, Harvey Mudd's mascot.

<img width="1917" height="986" alt="image" src="https://github.com/user-attachments/assets/51d8fe22-5be9-43d1-9054-b3349f1a38a6" />
## Features

* **Searchable resource directory** for HMC programs, services, clubs, and opportunities
* **Categorized resources** to make campus information easier to browse
* **Links to original sources** so users can quickly access official information
* **AI-powered search** designed to eventually let students ask questions in natural language 

## Technical Details

WallyWiki currently uses a lightweight frontend built with **HTML, CSS, and vanilla JavaScript**, with **Vercel** handling deployment. The interface is intentionally simple and fast, with client-side search and filtering over the resource data.

The larger goal is to turn the site into a searchable knowledge base built from HMC's existing web ecosystem. A backend can periodically collect and process information from campus websites, normalize it into a common structure, and index it for search.

For the AI component, the plan is to use **retrieval-augmented generation (RAG)**: rather than asking an LLM to rely on its existing knowledge, WallyWiki would retrieve relevant HMC resources and provide them as context for each question. This allows answers to be grounded in current campus information and linked back to their original sources.

I'm also exploring ways to automatically categorize and update resources as new information appears, reducing the amount of manual maintenance required.

## Tech Stack

**Current**

* HTML
* CSS
* JavaScript
* Vercel

**Planned**

* Web scraping / site indexing
* Backend API and database
* Full-text and semantic search
* Embeddings / vector database
* LLM-powered RAG chatbot
* Automated resource categorization and updates

## Why I Built It

Harvey Mudd has a lot of great resources, but finding them often means knowing which website, department, or page to look at. WallyWiki is an attempt to make that information easier to discover while exploring how AI can improve the way students navigate campus information.

## Links

[Live Site — wally-wiki.vercel.app](https://wally-wiki.vercel.app)
