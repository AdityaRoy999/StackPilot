"""Qualify actual low-latency JPEG to H.264 packets and independent keyframes."""
from fractions import Fraction
import unittest
import av
from app.browser_rtc import JpegPacketEncoder


class HostCodecTests(unittest.TestCase):
    def jpeg(self,value,width=128,height=72):
        frame=av.VideoFrame(width,height,'yuv420p')
        for index,plane in enumerate(frame.planes):
            plane.update(bytes([value if index==0 else 128])*plane.buffer_size)
        codec=av.CodecContext.create('mjpeg','w')
        codec.width,codec.height=width,height
        codec.pix_fmt='yuvj420p'
        codec.time_base=Fraction(1,30)
        frame.pts=0
        return b''.join(bytes(packet) for packet in codec.encode(frame))

    def test_every_input_returns_current_pixels_without_future_frame_buffering(self):
        encoder=JpegPacketEncoder()
        decoder=av.CodecContext.create('h264','r')
        pixels=[]
        for index,value in enumerate([40,100,180]):
            payload=encoder.encode(self.jpeg(value),index*3000)
            self.assertTrue(payload)
            frames=decoder.decode(av.Packet(payload))
            self.assertEqual(len(frames),1)
            self.assertEqual((frames[0].width,frames[0].height),(128,72))
            pixels.append(bytes(frames[0].planes[0])[0])
        self.assertEqual(len(set(pixels)),3)

    def test_periodic_packets_recover_a_new_decoder_without_an_old_history(self):
        encoder=JpegPacketEncoder()
        jpeg=self.jpeg(100)
        independent=0
        for index in range(35):
            payload=encoder.encode(jpeg,index*3000)
            if b'\x00\x00\x00\x01\x67' in payload:
                frames=av.CodecContext.create('h264','r').decode(av.Packet(payload))
                self.assertEqual(len(frames),1)
                independent+=1
        self.assertGreaterEqual(independent,3)

    def test_viewport_change_starts_a_decodable_new_stream(self):
        encoder=JpegPacketEncoder()
        encoder.encode(self.jpeg(50),0)
        payload=encoder.encode(self.jpeg(150,160,90),3000)
        frames=av.CodecContext.create('h264','r').decode(av.Packet(payload))
        self.assertEqual((frames[0].width,frames[0].height),(160,90))
