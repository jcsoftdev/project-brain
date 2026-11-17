/** What the preview pane draws: plain lines of a text file, or a cached PNG of an image or a video frame. */
export type PreviewView = {
  id: number
  title: string
  note: string
  lines: string[]
  image: string
  generation: number
}

declare module 'claude-code' {
  interface PluginState {
    'project-brain-file-preview': {
      view: Shaped<PreviewView>
    }
  }
}
