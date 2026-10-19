function todayPlus(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function defaultMovies() {
  return [
    {
      id: 'm_static01', title: 'Midnight Static', genre: 'Sci-Fi \u00b7 Thriller', rating: 'PG-13',
      duration: 118, status: 'showing', image: '', grad: 0,
      synopsis: "A late-night radio host starts receiving broadcasts from a city that vanished thirty years ago -- and the callers know things they shouldn't.",
      showtimes: [
        { id: 'st_1', date: todayPlus(0), time: '1:00 PM', hall: 'Main Hall' },
        { id: 'st_2', date: todayPlus(0), time: '4:15 PM', hall: 'Main Hall' },
        { id: 'st_3', date: todayPlus(0), time: '7:30 PM', hall: 'Main Hall' },
        { id: 'st_4', date: todayPlus(1), time: '2:00 PM', hall: 'Main Hall' },
        { id: 'st_5', date: todayPlus(1), time: '7:30 PM', hall: 'Main Hall' },
      ],
    },
    {
      id: 'm_ember02', title: 'The Last Ember', genre: 'Drama', rating: 'PG-13',
      duration: 132, status: 'showing', image: '', grad: 1,
      synopsis: "When a wildfire threatens their family's century-old lumber town, three estranged siblings return home to decide what's worth saving.",
      showtimes: [
        { id: 'st_6', date: todayPlus(0), time: '12:30 PM', hall: 'Main Hall' },
        { id: 'st_7', date: todayPlus(0), time: '6:00 PM', hall: 'Main Hall' },
        { id: 'st_8', date: todayPlus(2), time: '3:00 PM', hall: 'Main Hall' },
      ],
    },
    {
      id: 'm_velvet03', title: 'Velvet Heist', genre: 'Action \u00b7 Comedy', rating: 'R-13',
      duration: 105, status: 'showing', image: '', grad: 2,
      synopsis: 'Six ex-con art restorers reunite for one impossible job: stealing a painting from the museum that framed them -- during its own gala.',
      showtimes: [
        { id: 'st_9', date: todayPlus(0), time: '2:45 PM', hall: 'Main Hall' },
        { id: 'st_10', date: todayPlus(0), time: '9:15 PM', hall: 'Main Hall' },
        { id: 'st_11', date: todayPlus(1), time: '5:30 PM', hall: 'Main Hall' },
      ],
    },
    {
      id: 'm_paper04', title: 'Paper Moons', genre: 'Animated \u00b7 Family', rating: 'G',
      duration: 96, status: 'showing', image: '', grad: 3,
      synopsis: 'A paper airplane folded from a wish takes flight across a city of forgotten letters, searching for the one person who still remembers how to read them.',
      showtimes: [
        { id: 'st_12', date: todayPlus(0), time: '11:00 AM', hall: 'Main Hall' },
        { id: 'st_13', date: todayPlus(0), time: '1:30 PM', hall: 'Main Hall' },
        { id: 'st_14', date: todayPlus(1), time: '11:00 AM', hall: 'Main Hall' },
      ],
    },
    {
      id: 'm_glass05', title: 'Glass Horizon', genre: 'Sci-Fi', rating: 'PG-13',
      duration: 0, status: 'soon', image: '', grad: 4, release: todayPlus(20),
      synopsis: "The first crewed ship to reach the edge of the solar system finds it isn't empty -- it's waiting.",
      showtimes: [],
    },
    {
      id: 'm_ballroom06', title: 'Crimson Tide Ballroom', genre: 'Musical \u00b7 Drama', rating: 'PG-13',
      duration: 0, status: 'soon', image: '', grad: 5, release: todayPlus(34),
      synopsis: "A closed-down seaside ballroom gets one last night of music before demolition, and the dancers who built it there won't let it go quietly.",
      showtimes: [],
    },
    {
      id: 'm_wayfinder07', title: "The Wayfinder's Code", genre: 'Adventure', rating: 'PG',
      duration: 0, status: 'soon', image: '', grad: 0, release: todayPlus(48),
      synopsis: "A cartographer's daughter inherits a map that redraws itself -- and a race to the last uncharted island on Earth.",
      showtimes: [],
    },
  ];
}

// Holy Angel University / Center for Kapampangan Studies films, added once on startup.
function featuredMovies() {
  const times = (a) => [0, 1, 2, 3, 4].flatMap((n) => a.map((t, i) => ({
    id: `st_f${n}${i}${t.replace(/\W/g, '')}`, date: todayPlus(n), time: t, hall: 'Main Hall',
  })));
  return [
    {
      id: 'm_ari_hau', title: 'ARI', genre: 'Drama', rating: 'PG',
      duration: 100, status: 'showing', image: '/posters/ari.jpg', grad: 0,
      synopsis: 'ARI: My Life with a King. Holy Angel University presents an award-winning film, graded A by the Cinema Evaluation Board.',
      showtimes: times(['10:00 AM', '2:00 PM']),
    },
    {
      id: 'm_aria_hau', title: 'ARIA', genre: 'Musical \u00b7 Drama', rating: 'PG',
      duration: 0, status: 'showing', image: '/posters/aria.jpg', grad: 1,
      synopsis: "One woman's love song. One nation's battle hymn. Holy Angel University Center for Kapampangan Studies presents ARIA, directed by Carlo Enciso Catu.",
      showtimes: times(['12:00 PM', '4:00 PM']),
    },
  ];
}

module.exports = { defaultMovies, featuredMovies, todayPlus };