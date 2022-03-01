import React, {useState, useCallback} from 'react'
import _ from 'lodash'
import {Segment, Menu, Header, Label, Icon, Table} from 'semantic-ui-react'
import {Layer, Source} from 'react-map-gl'
import {of, from, concat} from 'rxjs'
import {useObservable} from 'rxjs-hooks'
import {switchMap, distinctUntilChanged} from 'rxjs/operators'
import Chart from "react-apexcharts";

import api from 'api'

import styles from './styles.module.less'

const UNITS = {distanceOvertaker: 'm', distanceStationary: 'm', speed: 'm/s'}
const LABELS = {distanceOvertaker: 'Overtaker', distanceStationary: 'Stationary', speed: 'Speed'}
const ZONE_COLORS = {urban: 'olive', rural: 'brown', motorway: 'purple'}
const CARDINAL_DIRECTIONS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']
const getCardinalDirection = (bearing) =>
  bearing == null
    ? 'unknown'
    : CARDINAL_DIRECTIONS[
        Math.floor(((bearing / 360.0) * CARDINAL_DIRECTIONS.length + 0.5) % CARDINAL_DIRECTIONS.length)
      ] + ' bound'

function RoadStatsTable({data}) {
  return (
    <Table size="small" compact>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>Property</Table.HeaderCell>
          <Table.HeaderCell>n</Table.HeaderCell>
          <Table.HeaderCell>min</Table.HeaderCell>
          <Table.HeaderCell>q50</Table.HeaderCell>
          <Table.HeaderCell>max</Table.HeaderCell>
          <Table.HeaderCell>mean</Table.HeaderCell>
          <Table.HeaderCell>unit</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {['distanceOvertaker', 'distanceStationary', 'speed'].map((prop) => (
          <Table.Row key={prop}>
            <Table.Cell>{LABELS[prop]}</Table.Cell>
            {['count', 'min', 'median', 'max', 'mean'].map((stat) => (
              <Table.Cell key={stat}>{data[prop]?.statistics?.[stat]?.toFixed(stat === 'count' ? 0 : 3)}</Table.Cell>
            ))}
            <Table.Cell>{UNITS[prop]}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  )
}

class Palette {
  constructor(p, colorInvalid) {
    this.colorInvalid = colorInvalid
    this.resamplePalette(p, 256)
  }

  rgba(v) {
    if (v == undefined) {
      return this.colorInvalid
    }
    var i = ((v - this.a) / (this.b - this.a)) * (this.n - 1)
    i = Math.round(i)
    i = Math.max(0, Math.min(this.n - 1, i))
    return this.rgba_sampled[i]
  }

  rgba_css(v) {
    var color = this.rgba(v)
    return 'rgba(' + [color[0], color[1], color[2], color[3]].join(',') + ')'
  }

  rgb_css(v) {
    var color = this.rgba(v)
    return 'rgb(' + [color[0], color[1], color[2]].join(',') + ')'
  }

  rgb_hex(v) {
    var color = this.rgba(v)

    var s = '#' + this.hex2digits(color[0]) + this.hex2digits(color[1]) + this.hex2digits(color[2])

    return s
  }

  hex2digits(v) {
    var hex = v.toString(16)
    return hex.length == 1 ? '0' + hex : hex
  }

  samplePalette(palette, d) {
    var x = Object.keys(palette)

    for (var i = 0; i < x.length; i++) {
      x[i] = parseFloat(x[i])
    }

    x = x.sort(function (a, b) {
      return a - b
    })

    var n = x.length
    var y

    if (d <= x[0]) {
      y = palette[x[0]]
    } else if (d >= x[n - 1]) {
      y = palette[x[n - 1]]
    } else {
      var ia = 0
      var ib = n - 1

      while (ib - ia > 1) {
        var ic = Math.round(0.5 * (ia + ib))
        if (d < x[ic]) {
          ib = ic
        } else {
          ia = ic
        }
      }

      var xa = x[ia]
      var xb = x[ib]
      var w = (d - xa) / (xb - xa)
      y = Array(4)
      var ya = palette[xa]
      var yb = palette[xb]
      for (var i = 0; i < 4; i++) {
        y[i] = Math.round(ya[i] * (1 - w) + yb[i] * w)
      }
    }
    return y
  }

  resamplePalette(palette, n) {
    var x = Object.keys(palette)

    for (var i = 0; i < x.length; i++) {
      x[i] = parseFloat(x[i])
    }

    var a = Math.min(...x)
    var b = Math.max(...x)

    var p = new Array(n)

    for (var i = 0; i < n; i++) {
      var xi = a + (parseFloat(i) / (n - 1)) * (b - a)
      p[i] = this.samplePalette(palette, xi)
    }

    this.a = a
    this.b = b
    this.rgba_sampled = p
    this.n = n
  }
}

var paletteUrban = new Palette(
  {
    0.0: [64, 0, 0, 255],
    1.4999: [196, 0, 0, 255],
    1.5: [196, 196, 0, 255],
    2.0: [0, 196, 0, 255],
    2.55: [0, 255, 0, 255],
  },
  [0, 0, 196, 255]
)

var paletteRural = new Palette(
  {
    0.0: [64, 0, 0, 255],
    1.9999: [196, 0, 0, 255],
    2.0: [196, 196, 0, 255],
    2.5: [0, 196, 0, 255],
    2.55: [0, 255, 0, 255],
  },
  [0, 0, 196, 255]
)

var hist_xa = 0.0;
var hist_xb = 2.55;
var hist_xb_extends_to_infinity = true;
var hist_dx = 0.25;
var hist_n = Math.ceil((hist_xb - hist_xa) / hist_dx);

function histogramLabels() {

  var labels = Array(hist_n);
  for (var i = 0; i < hist_n; i++) {
    var xa = hist_xa + hist_dx * i;
    var xb = xa + hist_dx;
    var xc = xa + 0.5 * hist_dx;
    if (hist_xb_extends_to_infinity &&  (i == hist_n - 1)){
      labels[i] = "≥" + (xa * 100).toFixed(0)
    } else {
      labels[i] = (xa * 100).toFixed(0) + "-" + (xb * 100).toFixed(0);
    }
  }

  return labels;
}

function histogramColors(palette) {

  var colors = Array(hist_n);
  for (var i = 0; i < hist_n; i++) {
    var xc = hist_xa + hist_dx * i;
    colors[i] = palette.rgb_hex(xc);
  }

  return colors;
}

function histogram(samples) {
  var binCounts = new Array(hist_n).fill(0);

  for (var i = 0; i < samples.length; i++) {
    var v = samples[i];
    var j = Math.floor((v - hist_xa) / hist_dx);
    if (hist_xb_extends_to_infinity){
      j = Math.min(j, hist_n - 1);
    }
    if (j >= 0 && j < hist_n) {
      binCounts[j]++;
    }
  }

  return binCounts;
}


function RoadHistogramTable({data}) {
  var zone = data["zone"];
  data = data["data"];
  var colors = histogramColors(paletteUrban).reverse();
  switch (zone) {
    case "urban":
      colors = histogramColors(paletteUrban).reverse();
      break;
    case "rural":
      colors = histogramColors(paletteRural).reverse();
      break;
    default:
      colors = histogramColors(paletteUrban).reverse();
  }

  var buckets = {
      options: {
        chart: {
          id: "overtakers",
        },
        xaxis: {
          categories: histogramLabels().reverse(),
          title: {
            text: 'overtaker distance [m]'
          },
        },
        colors: [function({ v, idx, dataPointIndex, w }) {
          return colors[Math.max(0,dataPointIndex-1)];
        }]
      },
      series: [
        {
          name: "overtakers",
          data: histogram(data["distanceOvertaker"]["values"]).reverse(),
          labels: {
            show: false
          }
        }
      ]
    };

  return (
    <div className="mixed-chart">
      <Chart
        options={buckets.options}
        series={buckets.series}
        type="bar"
        width="100%"
      />
    </div>
  )
}

export default function RoadInfo({clickLocation}) {
  const [direction, setDirection] = useState('forwards')

  const onClickDirection = useCallback(
    (e, {name}) => {
      e.preventDefault()
      e.stopPropagation()
      setDirection(name)
    },
    [setDirection]
  )

  const info = useObservable(
    (_$, inputs$) =>
      inputs$.pipe(
        distinctUntilChanged(_.isEqual),
        switchMap(([location]) =>
          location
            ? concat(
                of(null),
                from(
                  api.get('/mapdetails/road', {
                    query: {
                      ...location,
                      radius: 100,
                    },
                  })
                )
              )
            : of(null)
        )
      ),
    null,
    [clickLocation]
  )

  if (!clickLocation) {
    return null
  }

  const loading = info == null

  const offsetDirection = info?.road?.oneway ? 0 : direction === 'forwards' ? 1 : -1 // TODO: change based on left-hand/right-hand traffic

  const content =
    !loading && !info.road ? (
      'No road found.'
    ) : (
      <>
        <Header as="h3">{loading ? '...' : info?.road.name || 'Unnamed way'}</Header>

        {info?.road.zone && (
          <Label size="small" color={ZONE_COLORS[info?.road.zone]}>
            {info?.road.zone}
          </Label>
        )}

        {info?.road.oneway && (
          <Label size="small" color="blue">
            <Icon name="long arrow alternate right" fitted /> oneway
          </Label>
        )}

        {info?.road.oneway ? null : (
          <Menu size="tiny" fluid secondary>
            <Menu.Item header>Direction</Menu.Item>
            <Menu.Item name="forwards" active={direction === 'forwards'} onClick={onClickDirection}>
              {getCardinalDirection(info?.forwards?.bearing)}
            </Menu.Item>
            <Menu.Item name="backwards" active={direction === 'backwards'} onClick={onClickDirection}>
              {getCardinalDirection(info?.backwards?.bearing)}
            </Menu.Item>
          </Menu>
        )}

        {info?.[direction] && <RoadStatsTable data={info[direction]} />}
        {info?.[direction] && <RoadHistogramTable data={{"data": info[direction], "zone": info.road.zone}} />}
      </>
    )

  return (
    <>
      {info?.road && (
        <Source id="highlight" type="geojson" data={info.road.geometry}>
          <Layer
            id="route"
            type="line"
            paint={{
              'line-width': ['interpolate', ['linear'], ['zoom'], 14, 6, 17, 12],
              'line-color': '#18FFFF',
              'line-opacity': 0.5,
              ...{
                'line-offset': [
                  'interpolate',
                  ['exponential', 1.5],
                  ['zoom'],
                  12,
                  offsetDirection,
                  19,
                  offsetDirection * 8,
                ],
              },
            }}
          />
        </Source>
      )}

      {content && (
        <div className={styles.mapInfoBox}>
          <Segment loading={loading}>{content}</Segment>
        </div>
      )}
    </>
  )
}
