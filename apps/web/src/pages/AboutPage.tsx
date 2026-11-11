import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

import { TextLink } from "../components/links";
import { Pill } from "../components/Pill";

export function AboutPage() {
  return (
    <Container sx={{ pt: { xs: 3, md: 5 } }}>
      <Typography variant="h1" sx={{ mb: { xs: 3, md: 5 } }}>
        About &amp; Help
      </Typography>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { md: "15rem minmax(0, 46rem)" },
          columnGap: 6,
          alignItems: "start",
        }}
      >
        <Box
          component="nav"
          aria-label="On this page"
          sx={{ display: { xs: "none", md: "block" }, position: "sticky", top: 24 }}
        >
          <Typography
            variant="overline"
            component="p"
            sx={{ borderBottom: 1, borderColor: "divider", pb: 0.5, mb: 1 }}
          >
            On this page
          </Typography>
          <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0 }}>
            {contents.map(([id, title]) => (
              <Box component="li" key={id} sx={{ py: 0.5 }}>
                <TextLink
                  to="/about"
                  hash={id}
                  variant="body2"
                  underline="hover"
                  color="text.primary"
                >
                  {title}
                </TextLink>
              </Box>
            ))}
          </Box>
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Stack component="section" spacing={2} aria-labelledby="about-archive" sx={{ mb: 6 }}>
            <Typography
              variant="h2"
              id="about-archive"
              sx={{ borderBottom: 1, borderColor: "divider", pb: 1, scrollMarginTop: 24 }}
            >
              About the archive
            </Typography>
            <Typography>
              Swayambhu Stories is a searchable archive of oral-history interviews about the
              Swayambhu stupa in Kathmandu. You can search across every public interview and jump
              straight to the moment where something is said.
            </Typography>
            <ClientText>
              Who made the archive, why, and how the interviews were collected. Credits for the
              interviewees, Baakhan Nyane Waa and the UNC team.
            </ClientText>
          </Stack>

          <Box component="section" aria-labelledby="faq">
            <Typography
              variant="h2"
              id="faq"
              sx={{ borderBottom: 1, borderColor: "divider", pb: 1, scrollMarginTop: 24 }}
            >
              Questions
            </Typography>

            <Question id="searching" title="How do I search?">
              <Typography>
                Type a few words about what you&apos;re looking for, such as a place, a festival or
                a ritual, and press Search. Searches in English work best for now. You can narrow
                the results by the interview&apos;s language, the interviewee and the recording
                date.
              </Typography>
            </Question>

            <Question id="moments" title="What is a moment?">
              <Typography>
                A moment is a short stretch of an interview, about a minute long, with the time it
                starts. Choose its “Open at” button to play the interview from there. Inside an
                interview, use “Find in transcript” to look for other places a word comes up.
              </Typography>
            </Question>

            <Question id="exact-words" title="Why doesn't a result contain my words?">
              <Typography>
                The search looks for meaning as well as exact words, so it also finds moments that
                talk about the same thing in other words. Those results say “Related by meaning”:
                your exact words may not appear in them.
              </Typography>
            </Question>

            <Question id="machine-transcripts" title="Who wrote the transcripts and translations?">
              <Typography>
                A computer did. Each recording is transcribed by speech-recognition software and
                translated into English by machine translation, so both can contain mistakes,
                especially with names and places. Lines marked “Corrected” were fixed by the archive
                team. The recording itself is always the best source.
              </Typography>
            </Question>

            <Question id="english-missing" title="Why is there no English for some interviews?">
              <Typography>
                Either the translation is still being made, or machine translation couldn&apos;t
                handle the language. This happens most with Nepal Bhasa, which translation services
                support poorly. The English tab tells you which it is. The original-language
                transcript is still there.
              </Typography>
            </Question>

            <Question id="languages" title="Which languages are the interviews in?">
              <Typography>
                Mostly Nepali and Nepal Bhasa (Newari), with some English. Nepal Bhasa is a language
                of its own, not a dialect of Nepali. Some interviews switch between languages.
              </Typography>
            </Question>

            <Question id="share" title="How do I share a moment?">
              <Typography>
                Open the moment from a search result. The address in your browser then points to
                that exact time, so copy it and send it. Whoever opens it starts at the same place.
              </Typography>
            </Question>

            <Question id="cite" title="How do I cite an interview?">
              <Typography>
                Until the archive team confirms its preferred format, you can use this one, filling
                in the parts in braces from the interview&apos;s page:
              </Typography>
              <Box
                component="p"
                sx={{
                  m: 0,
                  p: 2,
                  bgcolor: "background.paper",
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 1,
                  overflowWrap: "anywhere",
                }}
              >
                “{"{Interview title}"}”, interview with {"{interviewee}"}, Swayambhu Stories
                archive, {"{web address of the moment}"}. Accessed {"{date}"}.
              </Box>
              <Typography variant="body2" color="text.secondary">
                The web address of a moment is the one your browser shows after you open the
                interview at that moment, so readers start at the same place.
              </Typography>
              <Box>
                <Pill tone="amber">Suggested format, pending the archive team&apos;s approval</Pill>
              </Box>
            </Question>

            <Question
              id="contact"
              title="How do I ask for a correction or for an interview to be removed?"
            >
              <Typography>
                Tell us the interview&apos;s title, and the time in the recording if it&apos;s about
                one line.
              </Typography>
              <ClientText>
                Who to contact for corrections and removal requests (an email address or form), and
                how quickly they can expect an answer.
              </ClientText>
            </Question>
          </Box>

          <Typography sx={{ mt: 6 }}>
            <TextLink to="/">Go to the archive</TextLink>
          </Typography>
        </Box>
      </Box>
    </Container>
  );
}

// The rail on wide screens. Keep in step with the sections below.
const contents = [
  ["about-archive", "About the archive"],
  ["searching", "How do I search?"],
  ["moments", "What is a moment?"],
  ["exact-words", "Why doesn't a result contain my words?"],
  ["machine-transcripts", "Who wrote the transcripts?"],
  ["english-missing", "Why is there no English?"],
  ["languages", "Which languages?"],
  ["share", "How do I share a moment?"],
  ["cite", "How do I cite an interview?"],
  ["contact", "Corrections and removals"],
] as const;

function Question({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  // The id lets other pages link straight to one answer, e.g. /about#machine-transcripts.
  return (
    <Stack
      component="section"
      spacing={1}
      aria-labelledby={id}
      sx={{ py: 2.5, borderBottom: 1, borderColor: "divider" }}
    >
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
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Pill tone="amber">Pending</Pill>
        <Typography variant="overline" color="text.secondary">
          Text to come from the archive team
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {children}
      </Typography>
    </Box>
  );
}
