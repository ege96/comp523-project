import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

import { TextLink } from "../components/links";

/**
 * About & Help for visitors (documentation plan §3): what the archive is, then an FAQ with
 * the question as a heading and the short answer first. The answers describe how the app
 * works today. Anything only the archive team can say (who runs it, how to cite, who to
 * contact) sits in a marked box until they send the wording.
 */
export function AboutPage() {
  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Typography variant="h1" gutterBottom>
        About &amp; Help
      </Typography>

      <Stack component="section" spacing={2} aria-labelledby="about-archive" sx={{ mb: 6 }}>
        <Typography variant="h2" id="about-archive">
          About the archive
        </Typography>
        <Typography>
          Swayambhu Stories is a searchable archive of oral-history interviews about the Swayambhu
          stupa in Kathmandu. You can search across every public interview and jump straight to the
          moment where something is said.
        </Typography>
        <ClientText>
          Who made the archive, why, and how the interviews were collected. Credits for the
          interviewees, Baakhan Nyane Waa and the UNC team.
        </ClientText>
      </Stack>

      <Box component="section" aria-labelledby="faq">
        <Typography variant="h2" id="faq" gutterBottom>
          Questions
        </Typography>

        <Question id="searching" title="How do I search?">
          <Typography>
            Type a few words about what you&apos;re looking for, such as a place, a festival or a
            ritual, and press Search. Searches in English work best for now. You can narrow the
            results by the interview&apos;s language, the interviewee and the recording date.
          </Typography>
        </Question>

        <Question id="moments" title="What is a moment?">
          <Typography>
            A moment is a short stretch of an interview, about a minute long, with the time it
            starts. Press the time to play the recording from there, or open the whole interview.
            Inside an interview, use “Find in transcript” to look for other places a word comes up.
          </Typography>
        </Question>

        <Question id="exact-words" title="Why doesn't a result contain my words?">
          <Typography>
            The search looks for meaning as well as exact words, so it also finds moments that talk
            about the same thing in other words. Those results say “Related in meaning. Your exact
            words may not appear here.”
          </Typography>
        </Question>

        <Question id="machine-transcripts" title="Who wrote the transcripts and translations?">
          <Typography>
            A computer did. Each recording is transcribed by speech-recognition software and
            translated into English by machine translation, so both can contain mistakes, especially
            with names and places. Lines marked “Corrected” were fixed by the archive team. The
            recording itself is always the best source.
          </Typography>
        </Question>

        <Question id="english-missing" title="Why is there no English for some interviews?">
          <Typography>
            Either the translation is still being made, or machine translation couldn&apos;t handle
            the language. This happens most with Nepal Bhasa, which translation services support
            poorly. The English tab tells you which it is. The original-language transcript is still
            there.
          </Typography>
        </Question>

        <Question id="languages" title="Which languages are the interviews in?">
          <Typography>
            Mostly Nepali and Nepal Bhasa (Newari), with some English. Nepal Bhasa is a language of
            its own, not a dialect of Nepali. Some interviews switch between languages.
          </Typography>
        </Question>

        <Question id="share" title="How do I share a moment?">
          <Typography>
            Open the moment from a search result. The address in your browser then points to that
            exact time, so copy it and send it. Whoever opens it starts at the same place.
          </Typography>
        </Question>

        <Question id="cite" title="How do I cite an interview?">
          <ClientText>The citation format the archive would like scholars to use.</ClientText>
        </Question>

        <Question
          id="contact"
          title="How do I ask for a correction or for an interview to be removed?"
        >
          <Typography>
            Tell us the interview&apos;s title, and the time in the recording if it&apos;s about one
            line.
          </Typography>
          <ClientText>
            Who to contact for corrections and removal requests (an email address or form), and how
            quickly they can expect an answer.
          </ClientText>
        </Question>
      </Box>

      <Typography sx={{ mt: 6 }}>
        <TextLink to="/">Go to the archive</TextLink>
      </Typography>
    </Container>
  );
}

function Question({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  // The id lets other pages link straight to one answer, e.g. /about#machine-transcripts.
  return (
    <Stack component="section" spacing={1} aria-labelledby={id} sx={{ py: 2.5 }}>
      <Typography variant="h3" id={id} sx={{ scrollMarginTop: 24 }}>
        {title}
      </Typography>
      {children}
    </Stack>
  );
}

/** Wording the archive team still has to supply. Shown as a marked box, never as real copy. */
function ClientText({ children }: { children: ReactNode }) {
  return (
    <Box
      role="note"
      sx={{ border: 1, borderStyle: "dashed", borderColor: "divider", borderRadius: 1, p: 2 }}
    >
      <Typography variant="overline" color="text.secondary">
        Text to come from the archive team
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {children}
      </Typography>
    </Box>
  );
}
