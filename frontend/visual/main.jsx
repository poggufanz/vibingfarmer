import { createElement } from 'react'
import { createRoot } from 'react-dom/client'

const params = new URLSearchParams(window.location.search)
const fixture = params.get('fixture') || 'foundation'
const theme = params.get('theme') || 'forest'

document.documentElement.dataset.theme = theme

function FoundationFixture() {
  return (
    <main data-fixture={fixture}>
      <h1>Pocket Crew visual harness</h1>
    </main>
  )
}

createRoot(document.getElementById('root')).render(createElement(FoundationFixture))
