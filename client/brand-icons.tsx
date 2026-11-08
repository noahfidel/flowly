import { memo } from "react";
import { Image, PixelRatio } from "react-native";
import type { ConnectorFamily } from "../shared/connectors";
import { flowlyMarkPng } from "./flowly-mark-data";
import { useTheme } from "./ui";

/**
 * Service logos for connectors (CONNECTORS-SPEC §8.3): the Simple Icons marks
 * (CC0, simpleicons.org), rendered once to 48 px PNGs. The host's Icon only
 * knows Lucide names and there is no SVG module, so they ship as data URIs
 * (about 6 KB in total). GitHub's mark is monochrome: a dark and a light
 * variant follow the theme. Azure DevOps uses its brand blue (#0078D4). Confluence uses Atlassian's current blue
 * (#1868DB) because its listed navy disappears on dark surfaces. Linear uses its brand indigo (#5E6AD2).
 */
const png = (data: string) => ({ uri: `data:image/png;base64,${data}` });
const logos = {
  jira: png("iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAB1UlEQVR4nNSZb3KCMBDFN4xH0s/FK9DeR7xP6xVKP8OZTNmk1Mr/DfsS+ptxHJ1ReOwj+7IcCEnRWEJhqCJjrwf6r1jKWUVGSPgqIWlFgAXYK4ExhAZ5H7RgK+DAVgFfAea1+fQ3nT5xBDAgEREs9MPH8YywU7wK/KWoy/bQF1IgjYCOtzqn+4itjHlZazdZJ546YCj33ufbqXTvvkI5rUAmwJ28TulHKZoLZfY8EDaD7CbOwNGAEVZYJuD9VFEMBBdKvoyaCFUQECAAH9AkyAU4G4FFCKwa1ol5uUNbaeX/h0cJUDT4ZaVVt2Uh13hAIlZadXuYYxG3o/EHa1+a1lph1R3G6fYidJGiYyb8HdBbvtETksK/L2oaE5HhG5NSdpqwapy5EKdYrTr3qpntrbNKydxytbN8I8EvozGqYO0XAfACYuQb0F7i0ciQXZUBWfW5E6NFAKw6jBJP660yAKtO9wG/3pbzk4iAJjXTVUNYbmR+c1ENvvfCwk5CUUS80WIfJaumE9DRCeF5EIsRLrf7eUY2ZdUF0ldgI+ECYg25FthWgR2EwG0CQAFNgsJUIi0KN3HaDZHOWCWhCJ1lNKEIvT6QSARmsOUGUfR4WMcxAdQ3vgEAAP//SSinTgAAAAZJREFUAwBDpLPrGYKvigAAAABJRU5ErkJggg=="),
  confluence: png("iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAACKUlEQVR4nNSai3HDIAyGZZ+H6AKdI3SbbhG8RbcpnqMLdIsUEuQSwksgEvPdJdjxQ/oRtoWcGQ7G2+ePoOw/ZU4mcfn3611CZ7S9b90Iu7qW2JwSJ5O6OXs/r72EROxlbc5A46wNXdzIMHKGuE0ZOygYgURv+LBEpMUeNQI+zREhOI/2pHuhxyJwgTpIESE6H7Q1MZ90P7n5SolhsqNCAmp7P8bqrZ9sK4CBxV158t2Fg/UuAh16vyt6iE57BDr1fk+uQ3OBMdnvdvsQGmj4KO38B664D7IVBsB13jA7G6S5KODYQh58o2ajryT4lJ9yRx1ESDRFyQpAXigkmV8VC0CeLCSbHJIFIM6Dr4cYBTfnVW7HagEujFFRUOg4wiIAsRMN8zlBebapbEtyHGEV4OPMnIS3SeFCjdMuzQK8Oo7wNivz1epkiioB1mkc86LwMKU/G9xyGQVMkAQ4jgtoh6WiUSSA2XGf7Pw5xdFSCXJUSmqjh0sfXI6ejdalEqOk0oZeha1ePAh5RmGrB7uQu+KufcEwAvsI8etCAsZA4cJVwMHHfYgNF67XwIglRVxeRi0pIhNj7yvbbt7vrEPT7X3DYg0LaCP1xJSM8+dwYYvjVU/pzi22/N43zHaD1I2pOVLLiuTssaGEGdzfrY0q60zpiZsmJFy12OpsNBTOFjL2lF+VRqLviTPRaOq1mL1ERLbYcaVTSgn/vRPtDU5K/2hCntT3LJHU8AcAAP///fYUzwAAAAZJREFUAwDXRheF4afoBQAAAABJRU5ErkJggg=="),
  azure: png("iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAACOklEQVR42u2ar1MCURDHNxAIBAOBYDAYCAYCwUAw+AcYCAbCBQLBYNxgYIZAMBgIBgKBYDAQDAaDgWAgGNwZg4FgIBgIBMMFnDfzZYY57w7u3r2Dm3lhZxjmfuznvbf73n73iFgo02YB/K1JLOdZBmgTi0ssXWLJZRVgCRsTy1GWAZTNieUiKwAFYnnwAKzsnljy+wpQhYOLAOdX9kEsJ/sCoEbTIZbJBqe9piBbuwRQI9jD2l5qmFpqB2kBqNG+JJZXTae9NsXyC3t3GUmAAT2JAqBS4C2x/CTs+Lq5cM7r6Dux/AbcsxGgTizPBh1WzvWJ5YpYTpG9ojwjFMBJ0NkFpryHI0YlJJUmAlDZIhUG2RwxckcsjRjpUhtATePXlg9QMfGE+FDL7TiBtKgNELSDfhPLiFhuEGSHho4gWgAtn4sGxFJM8XyvBeCXrtopFyhaAEsLYAEsgAWwABbAAliA+ADzrAMoDbNGLJ01mSRTAF4rQYXorKnN5cSVNYMAKxv63DzDLD2ifLxGoVPVrB+MABSgIEQt5D+havRRyaka+WyDUm0EgFBCzgwIWmPMcDegIkwMgDB6rkFxa2kagCBC7dpxF0kltrg72KHzi3+9txgAar9424HzU6TxROT1kk9QK03pxVCcjPHORBscpx5nHfxfxO9RiLIctYeQN9WhafoAePeQhgZMJ40eWS8EIC6Mi2tTafLloEg7ETuZdWxiCx/RuJZ2l7Kk8WlBHueoIc5XZfuxR5bsDzkN1aVg3iaUAAAAAElFTkSuQmCC"),
  gitlab: png("iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAACCklEQVR4nNSa4XXCIBCA73hxFdstGvepXUFdoe0+0i3arqIv1CNFEwIICAl8v9JEL9zdRwLPMqicxnXx9PrcInZHOhaCbVaf3xxm4PS23qOAnc99mSsQotiZjnODAl9872tNgKp/yb+9nRFtf24O/O9r7wDrWlgA0kc/5+qCNQHloG+gVAz1uTHsyBhjAqYqqED5NTIP1nZf5ySeG3vh7N03JmDS516g/Ji7P0nAVQUVCDLhKpzE8GBhwUHA7uMj3C+ceYKz0CAyUEEaRU7i9Br5dF5+TiseiwlCpNTIt/M94+KxuCBLajQu3nU12k8QAf6ke6mh6IKK8V88Lo/VyfN2HTL6xVHLbKlQqD4loBSWCoVM3nLoJzMOd121QRqxpdb9SbiMvYGKoSdnU6f/N6ruAE3ky2MUOVQL8qJ2ZDEwgeILKoXGzqBjHCpGroXO26djzq1iDgTCYfX+u5dzQAg8QKUMVqP1dEFVn45xeKGOJJA3Hz+b61/65bKTGA+emLwH6APUIiiO6eAJ44uM/CopCRqLafAEur64/F4BOT0hXb/QIHgw/MlnPszK6HitheZWyqWMjlcHFPmVuq/M5BsQQR6l/JTRiVpOp1YqRBmdqA4oHlcqXJlJBEhAnFJxyugk2ZGFKvWIMjpJOqDw6UTqf1lImoDCnEgaZXSybOp1pVIqo5OlA3PyBwAA//9etSDiAAAABklEQVQDAN5cCufRzu1BAAAAAElFTkSuQmCC"),
  linear: png("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"),
  githubDark: png("iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAC3klEQVR4nNRaSXbbMAyF1Cyddbz0TcrcJD1JnJO0PUmQm3Tp7J21SpCSSlGk+KmBUv97tugnDpgIAqAfaAOcz2fl/JQ2S+N2uzGtjIoWoie2aV7JEgusWr3JQzN0pYWYzYAhPIfoOFgz9DGXmWwGViQ8QE31lssIzMCmhLvINK9vSCdN/FUT/1M3L7Q9lHxOj4/V/X7nVOckAy3xr1QeEBOTDJyfnt7144X2Q5KJ6B7YUfIh8O3z8zn0IqiBgxEvuMQ0MWIgQbz47N/dpLQu7Nz6TKCwpwua08iEtN03FIFW46D/KpqybpO7MKN11+8T/Z/dkCSLIJ+BfkGRmB3H7SIffdtC9a2m+U5dfGQPLh7NOSFE8vZDNXfglmi9n4p2cLRQ94NE+v8LHCsxDDhhwlGgUu+7KLgGB6B9SkLJl2XAbqxptEFWIXCyR0tzjgaYSgETljGjGtq8EXe3Fdq1GOlbEwam0gC1UCP2X1L6WWtq2h8oDaYDQ0xI0XHBifcK3QOHBWJCe0KlOogGeOkkO4IhE/JKhUWABpfoHlB0ROi8o4YODCRWWhtgdAxroGS+kLEWm4wskYn9g5ePboGcPFtS3E4DjAyQZHtLTWQlVq3p1+4PCHqBtZkQwk0ePFWNGIPlq0/qA4m0SeK9qsMQCy4qZl2MeLQZEgYT+hJw6vWQbQJ7JFn3QeDQ1VfmdMXrz+l0UjSsuPXVMPkE3vuT/qIEIuvg8C5Bav/laIC1eSXNVm1MS2ELX3PB7o9BbdRIR0ucxjZ5uX99mZqoPAN9xCZ/EAitAXm8UC4CWg6W14OVsRXPgFn7IHJ/Fr8fiHglWgnw4ZlYOx5KjPeD+OpmhxLkpOCSt5QThVZzv9sFernaATWQ1Dp0zYqcAaHS++ScKQbAO2MoGjUTlSwtWodxRbrCSb1MaKS8JSMidb1Gjrdb8l+JgVktMCHubnTmuOnZDPSEdKf0jMVl7NKz5S8AAAD//9JTbSYAAAAGSURBVAMArWCPzG99a4kAAAAASUVORK5CYII="),
  githubLight: png("iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAC0klEQVR4nMxaTVrDIBAFvrpQN3oi68nUk1lPpBt1oV+QmUAlBMKDQJq3sVoS5p83gwfRAe/fP8fzL4M4CiVO9PH++uokGkOKlXDCSiGfhBZH5Bmt9Qv9vL+9ehYrUa0ACV4i9IIEJz3ot1plihVoJngE5JlSRWAFegruozS8IAXeP3+epTTCbwjUG1kFLiG8A6LEogIf37+vvUMmh5wSSQUuafkZTKW6uz48xr5SsT/uSniCiQKSKfbVzAOLwtuaLZV8aB5a9t38MbF/LJxmCnx8/WqRwN3NYbK+hae4bBqq4WgGl2stX5PrpX70KUmRQKECbkPiO/ycHDkPW9LyH8bw762z98jiwlg0wo+WjBjmg6x9sCdy1c/3wjmJU0myRzAjsGAFOO52VnVy3zsWPHpgACrKhQ+0GazMrAAnVgaOZG0C6RWA1BIr8+gBxLoq/9JWoOoELOIwUkjy8gHSoR1MgfeSmMEUsmhL6ztAXqDzB2GcsQNsCyyeSwTjpYPIQW5v/RKo3ZVHHznjGdmxHNgx8iF0SQDRoRA3ib3CyA6F0GRUuBFQconlwLBPL1DfoZADA+FKrYGyY8wDC011D8B7GYbAJ2z2xLMI+9EeKOmziSGMHgBPW2q2e3qipLFy9J4VgIiTBW3QWgkSnDjZ0jRiBkswzyRtRupsEz+ZOgRYc1FRczESyjZ+9F4YWsAfJCGxieRIbu6DwJdrOlaJUGt/8RL1LrmcWDM0DveZlNFYLnDMW3ez2xrQazdCrELQXE0UIPfHmnd/DkNKzNYYpYryoLLDi7W20U4rGkoNz4CaPEiFaLJVTFUl0Qjo4ZnbO0klZvlglKFNNx9BZgyXbdaTFcO/KxA2wQsAeQDwerNbytLJRU4BtCxDLSW9yCghthoAc8G4wQoG3NSTEmTlnjNSejftUVLt6v9XIgir6hByd2PeNVMJmv23Ss3m9Ozas+UPAAD//+GThUAAAAAGSURBVAMAwZXq9wQD5M8AAAAASUVORK5CYII="),
} as const;

/** Whether a theme color is dark (relative luminance below the midpoint); non-hex colors count as light. */
export function isDarkColor(color: string) {
  const hex = /^#([0-9a-f]{6})/i.exec(color.trim())?.[1];
  if (!hex) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.5;
}

export const BrandIcon = memo(function BrandIcon({ family, size = 16 }: { family: ConnectorFamily; size?: number }) {
  const { colors } = useTheme();
  const source = family === "github" ? (isDarkColor(colors.surface0) ? logos.githubLight : logos.githubDark) : logos[family];
  return <Image source={source} accessibilityIgnoresInvertColors style={{ width: size, height: size }} resizeMode="contain" />;
});

const flowlyMarks = {
  light: { 1: png(flowlyMarkPng.light[1]), 2: png(flowlyMarkPng.light[2]), 3: png(flowlyMarkPng.light[3]) },
  dark: { 1: png(flowlyMarkPng.dark[1]), 2: png(flowlyMarkPng.dark[2]), 3: png(flowlyMarkPng.dark[3]) },
} as const;

/**
 * Flowly's own mark (docs/brand/logo), small-size variant, for icons of 24 px and less such as
 * the welcome tour title. Light ink on light surfaces, paper on dark ones. Decorative: the
 * title next to it already says Flowly. Drawn for 20 pt: the PNG that matches the screen's
 * pixel ratio is shown, so the image is not resampled (60 px scaled to 40 blurs its thin lines).
 */
export const FlowlyMark = memo(function FlowlyMark({ surface, size = 20 }: { surface: string; size?: number }) {
  const scale = Math.min(3, Math.max(1, Math.ceil((size * PixelRatio.get()) / 20))) as 1 | 2 | 3;
  const source = (isDarkColor(surface) ? flowlyMarks.dark : flowlyMarks.light)[scale];
  return (
    <Image
      source={source}
      accessible={false}
      accessibilityIgnoresInvertColors
      style={{ width: size, height: size }}
      resizeMode="contain"
    />
  );
});

/** The Linear mark for the sidebar row (LINEAR-BOARD-SPEC §2); tinted with the host's color so it matches the other monochrome sidebar icons. */
export const LinearMark = memo(function LinearMark({ size, color }: { size: number; color: string }) {
  return <Image source={logos.linear} accessibilityIgnoresInvertColors style={{ width: size, height: size, tintColor: color }} resizeMode="contain" />;
});
